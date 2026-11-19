// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Helios usernames and player cards
/// @notice Registro degli username di Helios (unici, senza distinzione tra maiuscole e minuscole) collegati al wallet
///         del giocatore, più la "player card": un NFT soulbound (EIP-5192) con l'immagine SVG generata qui.
///         Nessun amministratore e nessun pagamento al contratto: si paga solo il gas.
///         - Un wallet ha al massimo un nome. Il nome si registra in due passi (commit, poi register dopo almeno un
///           minuto), come ENS: chi guarda le transazioni in attesa non può rubarlo registrandolo prima.
///         - Un amico può pagare per te (registerFor, mintFor): tu firmi gratis un'autorizzazione EIP-712 (nome e
///           chiave Nostr, o stile della card) con nonce e scadenza; senza la tua firma nessuno assegna niente al
///           tuo wallet. Le firme di smart wallet (ERC-1271) valgono come quelle normali.
///         - La chiave Nostr salvata con il nome NON è verificata qui (servirebbe una firma Schnorr): Helios accetta il
///           nome di un giocatore solo se anche il suo profilo Nostr firmato dichiara lo stesso nome e lo stesso
///           wallet. Per questo una chiave Nostr non è unica qui: nessuno può "occupare" la chiave di un altro.
///         Il contratto non è aggiornabile e non ha owner: le regole non cambiano dopo il deploy.
/// @dev Basato su OpenZeppelin Contracts 5.1.0 (ERC721, EIP712, Nonces, SignatureChecker, Base64, Strings).
///      Compilato per EVM "paris". ABI e bytecode: src/data/names-contract.json (npm run contracts).
contract HeliosNames is ERC721, EIP712, Nonces {
    using Strings for uint256;

    struct Name {
        address owner; // wallet del giocatore
        uint64 block_; // blocco della registrazione
        uint32 number; // numero progressivo della registrazione (1, 2, 3…): i primi OG_LIMIT sono gli "OG"
        bytes32 nostr; // chiave pubblica Nostr dichiarata (x-only, 32 byte)
        string display; // il nome come scritto (maiuscole comprese)
    }

    struct Card {
        bytes3 color; // #rrggbb
        uint8 pattern; // 0 rays, 1 grid, 2 waves, 3 hexagons, 4 stars, 5 plain
        string bio; // ASCII stampabile senza < > & " \ , al massimo 48 caratteri
    }

    uint256 public constant MIN_COMMIT_AGE = 60;
    uint256 public constant MAX_COMMIT_AGE = 1 days;

    // autorizzazioni firmate dal giocatore (EIP-712) quando paga un amico
    bytes32 private constant REGISTER_TYPEHASH = keccak256("Register(string name,bytes32 nostr,uint256 nonce,uint256 deadline)");
    bytes32 private constant MINT_TYPEHASH = keccak256("Mint(bytes3 color,uint8 pattern,string bio,uint256 nonce,uint256 deadline)");

    /// @notice I primi OG_LIMIT nomi registrati sono gli OG (la card lo mostra). Il numero non si riassegna mai.
    uint32 public constant OG_LIMIT = 100;

    uint256 public totalSupply;
    uint32 public namesRegistered; // contatore dei numeri (anche dei nomi poi liberati)

    mapping(bytes32 key => Name) private _names; // key = keccak256(nome in minuscolo)
    mapping(address owner => bytes32) public keyOfOwner;
    mapping(bytes32 commitment => uint256) public commitments; // impronta → timestamp del commit
    mapping(uint256 tokenId => Card) private _cards;

    event Registered(bytes32 indexed key, string name, address indexed owner, bytes32 nostr);
    event Released(bytes32 indexed key, address indexed owner);
    event Committed(bytes32 indexed commitment);
    event Locked(uint256 tokenId); // EIP-5192
    event CardStyled(uint256 indexed tokenId);

    error BadName();
    error NameTaken();
    error AlreadyRegistered();
    error NotRegistered();
    error BadNostrKey();
    error BadCommitment();
    error BadBio();
    error BadPattern();
    error CardExists();
    error BadSignature();
    error Expired();
    error Soulbound();

    constructor() ERC721("Helios Player Card", "HELIOS") EIP712("HeliosNames", "1") {}

    // ------------------------------------------------------------------ nomi

    /// @notice Chiave di un nome: keccak256 del nome in minuscolo. 3–20 caratteri tra A–Z, a–z, 0–9 e "_";
    ///         "duelist" (il nome predefinito di Helios) non si registra.
    function keyOf(string memory name) public pure returns (bytes32) {
        bytes memory b = bytes(name);
        if (b.length < 3 || b.length > 20) revert BadName();
        bytes memory low = new bytes(b.length);
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) c = bytes1(uint8(c) + 32);
            else if (!((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x5F)) revert BadName();
            low[i] = c;
        }
        bytes32 key = keccak256(low);
        if (key == keccak256("duelist")) revert BadName();
        return key;
    }

    /// @notice Impronta da mandare con commit(): secret è un numero casuale che resta nel browser fino al register.
    ///         payer è chi manderà il register (il giocatore stesso o l'amico che paga): copiarla non serve a nessun altro.
    function makeCommitment(string calldata name, address owner, bytes32 nostr, bytes32 secret, address payer) public pure returns (bytes32) {
        return keccak256(abi.encode(keyOf(name), owner, nostr, secret, payer));
    }

    /// @notice Primo passo: annuncia la registrazione senza rivelare il nome.
    /// @dev I confronti con block.timestamp sono voluti (commit-reveal come ENS): un validatore sposta il tempo di
    ///      pochi secondi, la finestra va da 1 minuto a 1 giorno.
    function commit(bytes32 commitment) external {
        // un commit ancora valido non si rinnova (si allungherebbe l'attesa di chi l'ha mandato)
        if (commitments[commitment] + MAX_COMMIT_AGE > block.timestamp) revert BadCommitment();
        commitments[commitment] = block.timestamp;
        emit Committed(commitment);
    }

    /// @notice Secondo passo (da 1 minuto a 1 giorno dopo il commit): registra `name` per il wallet che chiama.
    function register(string calldata name, bytes32 nostr, bytes32 secret) external {
        _useCommitment(makeCommitment(name, msg.sender, nostr, secret, msg.sender));
        _register(name, msg.sender, nostr);
    }

    /// @notice Un amico paga la registrazione di `owner`, che ha firmato (EIP-712) nome e chiave Nostr.
    function registerFor(string calldata name, address owner, bytes32 nostr, bytes32 secret, uint256 deadline, bytes calldata signature) external {
        _useCommitment(makeCommitment(name, owner, nostr, secret, msg.sender));
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REGISTER_TYPEHASH, keccak256(bytes(name)), nostr, _useNonce(owner), deadline)));
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert BadSignature();
        _register(name, owner, nostr);
    }

    function _useCommitment(bytes32 c) private {
        uint256 at = commitments[c];
        if (at == 0 || block.timestamp < at + MIN_COMMIT_AGE || block.timestamp > at + MAX_COMMIT_AGE) revert BadCommitment();
        delete commitments[c];
    }

    function _register(string calldata name, address owner, bytes32 nostr) private {
        bytes32 key = keyOf(name);
        if (nostr == bytes32(0) || owner == address(0)) revert BadNostrKey();
        if (_names[key].owner != address(0)) revert NameTaken();
        if (keyOfOwner[owner] != bytes32(0)) revert AlreadyRegistered();
        _names[key] = Name(owner, uint64(block.number), ++namesRegistered, nostr, name);
        keyOfOwner[owner] = key;
        emit Registered(key, name, owner, nostr);
    }

    /// @notice Il giocatore libera il proprio nome (e brucia la card): poi può registrarne un altro.
    function release() external {
        bytes32 key = keyOfOwner[msg.sender];
        if (key == bytes32(0)) revert NotRegistered();
        uint256 id = uint256(key);
        if (_ownerOf(id) != address(0)) {
            delete _cards[id];
            --totalSupply;
            _burn(id);
        }
        delete keyOfOwner[msg.sender];
        delete _names[key];
        emit Released(key, msg.sender);
    }

    /// @notice Registrazione di un nome (owner zero se è libero).
    function lookup(string calldata name) external view returns (address owner, bytes32 nostr, uint64 atBlock, uint32 number, string memory display) {
        Name storage n = _names[keyOf(name)];
        return (n.owner, n.nostr, n.block_, n.number, n.display);
    }

    /// @notice Nome registrato da un wallet ("" se nessuno), con la chiave Nostr dichiarata.
    function nameOfOwner(address owner) external view returns (string memory display, bytes32 nostr, uint32 number) {
        Name storage n = _names[keyOfOwner[owner]];
        return (n.display, n.nostr, n.number);
    }

    // ------------------------------------------------------------------ player card (NFT soulbound)

    /// @notice Conia la card del proprio nome sul proprio wallet (si paga solo il gas).
    function mint(bytes3 color, uint8 pattern, string calldata bio) external {
        _mintCard(msg.sender, color, pattern, bio);
    }

    /// @notice Un amico paga il conio della card di `owner`, che ha firmato (EIP-712) colore, motivo e frase.
    function mintFor(address owner, bytes3 color, uint8 pattern, string calldata bio, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(MINT_TYPEHASH, color, pattern, keccak256(bytes(bio)), _useNonce(owner), deadline)));
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert BadSignature();
        _mintCard(owner, color, pattern, bio);
    }

    function _mintCard(address owner, bytes3 color, uint8 pattern, string calldata bio) private {
        bytes32 key = keyOfOwner[owner];
        if (key == bytes32(0)) revert NotRegistered();
        uint256 id = uint256(key);
        if (_ownerOf(id) != address(0)) revert CardExists();
        _checkStyle(pattern, bio);
        _cards[id] = Card(color, pattern, bio);
        ++totalSupply;
        _mint(owner, id);
        emit Locked(id);
    }

    /// @notice Dominio EIP-712 per le firme (comodo per i client).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Cambia colore, motivo e frase della propria card.
    function setStyle(bytes3 color, uint8 pattern, string calldata bio) external {
        uint256 id = uint256(keyOfOwner[msg.sender]);
        if (id == 0 || _ownerOf(id) != msg.sender) revert ERC721NonexistentToken(id);
        _checkStyle(pattern, bio);
        Card storage c = _cards[id];
        (c.color, c.pattern, c.bio) = (color, pattern, bio);
        emit CardStyled(id);
        emit MetadataUpdate(id);
    }

    /// EIP-4906: i marketplace ricaricano l'immagine quando cambia lo stile
    event MetadataUpdate(uint256 tokenId);

    function _checkStyle(uint8 pattern, string calldata bio) private pure {
        if (pattern > 5) revert BadPattern();
        bytes calldata b = bytes(bio);
        if (b.length > 48) revert BadBio();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x20 || c > 0x7E || c == 0x3C || c == 0x3E || c == 0x26 || c == 0x22 || c == 0x5C) revert BadBio();
        }
    }

    function cardOf(address owner) external view returns (uint256 tokenId, bytes3 color, uint8 pattern, uint32 number, string memory bio) {
        tokenId = uint256(keyOfOwner[owner]);
        if (tokenId == 0 || _ownerOf(tokenId) == address(0)) return (0, 0, 0, 0, "");
        Card storage c = _cards[tokenId];
        return (tokenId, c.color, c.pattern, _names[bytes32(tokenId)].number, c.bio);
    }

    /// @notice EIP-5192: la card è sempre legata al wallet.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @dev Soulbound: solo conio (from = 0) e bruciatura (to = 0), nessun trasferimento.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// @dev Nessuna approvazione: la card non si muove.
    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == 0xb45a3c0e || id == 0x49064906 || super.supportsInterface(id); // EIP-5192, EIP-4906
    }

    /// @notice Metadati e immagine della card, generati qui (JSON e SVG in base64).
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        address o = _requireOwned(tokenId);
        Card storage c = _cards[tokenId];
        Name storage n = _names[bytes32(tokenId)];
        string memory image = string.concat('"image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(n, c, o))), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(string.concat(_meta(n, c), image))));
    }

    /// @dev Nome, descrizione e attributi (numero, OG, motivo) del JSON dei metadati, fino a "image".
    function _meta(Name storage n, Card storage c) private view returns (string memory) {
        string memory num = uint256(n.number).toString();
        bool og = n.number <= OG_LIMIT;
        return string.concat(
            '{"name":"#', num, " ", n.display, ' - Helios Player Card","description":"Helios username #', num,
            og ? " (OG)." : ".", bytes(c.bio).length > 0 ? string.concat(" ", c.bio) : "",
            '","attributes":[{"trait_type":"Number","display_type":"number","value":', num,
            '},{"trait_type":"OG","value":"', og ? "Yes" : "No",
            '"},{"trait_type":"Pattern","value":"', _patternName(c.pattern), '"}],'
        );
    }

    // ------------------------------------------------------------------ SVG (solo nomi [A-Za-z0-9_] e frasi già filtrate)

    function _svg(Name storage n, Card storage c, address o) private view returns (string memory) {
        string memory col = string.concat("#", _hex3(c.color));
        return string.concat(_frame(c.pattern, col), _top(n.display, col), _badge(n.number, col), _body(n, c, col, o), "</svg>");
    }

    function _frame(uint8 pattern, string memory col) private pure returns (string memory) {
        string memory defs = string.concat(
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="', col,
            '"/><stop offset="1" stop-color="#0b0c12"/></linearGradient>', _pattern(pattern),
            '<clipPath id="c"><rect x="1.5" y="1.5" width="397" height="557" rx="22"/></clipPath></defs>'
        );
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 560" font-family="monospace">', defs,
            '<rect x="1.5" y="1.5" width="397" height="557" rx="22" fill="#11131c"/>',
            '<g clip-path="url(#c)"><rect width="400" height="190" fill="url(#g)"/><rect width="400" height="190" fill="url(#p)"/></g>',
            '<rect x="1.5" y="1.5" width="397" height="557" rx="22" fill="none" stroke="', col, '" stroke-width="3"/>'
        );
    }

    /// @dev Numero della registrazione in alto a destra; i primi OG_LIMIT con la scritta OG dorata.
    function _badge(uint32 number, string memory col) private pure returns (string memory) {
        string memory num = string.concat("#", uint256(number).toString());
        string memory b = string.concat(
            '<rect x="268" y="22" width="110" height="34" rx="17" fill="#0b0c12" fill-opacity=".75" stroke="', col, '"/>',
            '<text x="323" y="45" fill="#fff" font-size="18" font-weight="700" text-anchor="middle">', num, "</text>"
        );
        if (number > OG_LIMIT) return b;
        return string.concat(b,
            '<rect x="296" y="62" width="54" height="22" rx="4" fill="#ffcf3b"/>',
            '<text x="323" y="78" fill="#0b0c12" font-size="14" font-weight="700" text-anchor="middle" letter-spacing="2">OG</text>');
    }

    function _top(string memory display, string memory col) private pure returns (string memory) {
        return string.concat(
            '<text x="28" y="44" fill="#fff" font-size="20" font-weight="700" letter-spacing="4">HELI<tspan fill="', col, '">OS</tspan></text>',
            '<circle cx="200" cy="200" r="66" fill="#11131c" stroke="', col, '" stroke-width="5"/>',
            '<text x="200" y="224" fill="', col, '" font-size="64" font-weight="700" text-anchor="middle">', _initial(display), "</text>"
        );
    }

    function _body(Name storage n, Card storage c, string memory col, address o) private view returns (string memory) {
        return string.concat(
            '<text x="200" y="320" fill="#fff" font-size="30" font-weight="700" text-anchor="middle">', n.display, "</text>",
            '<text x="200" y="356" fill="#c9cfdc" font-size="13" text-anchor="middle" font-style="italic">', c.bio, "</text>",
            '<line x1="40" y1="392" x2="360" y2="392" stroke="', col, '" stroke-opacity=".5"/>',
            _rows(n, o),
            '<text x="40" y="530" fill="', col, '" font-size="14" font-weight="700">USERNAME #', uint256(n.number).toString(), n.number <= OG_LIMIT ? " - OG" : "", "</text>",
            '<text x="360" y="530" fill="#8b93a7" font-size="12" text-anchor="end">ygoweb.eu</text>'
        );
    }

    function _rows(Name storage n, address o) private view returns (string memory) {
        return string.concat(
            _row(424, "NOSTR", string.concat(Strings.toHexString(uint256(uint48(bytes6(n.nostr))), 6), "...")),
            _row(452, "WALLET", string.concat(Strings.toHexString(uint256(uint48(bytes6(bytes20(o)))), 6), "...")),
            _row(480, "SINCE", string.concat("block ", uint256(n.block_).toString()))
        );
    }

    function _row(uint256 y, string memory label, string memory value) private pure returns (string memory) {
        string memory ys = y.toString();
        return string.concat(
            '<text x="40" y="', ys, '" fill="#8b93a7" font-size="12">', label, '</text><text x="360" y="', ys,
            '" fill="#e6ecf5" font-size="12" text-anchor="end">', value, "</text>"
        );
    }

    function _pattern(uint8 p) private pure returns (string memory) {
        string memory inner = ""; // 5 = plain: nessun motivo
        if (p == 0) inner = '<path d="M0 0L24 24" stroke="#fff" stroke-opacity=".12" stroke-width="2"/>';
        else if (p == 1) inner = '<path d="M24 0V24M0 24H24" stroke="#fff" stroke-opacity=".12"/>';
        else if (p == 2) inner = '<path d="M0 12Q6 4 12 12T24 12" fill="none" stroke="#fff" stroke-opacity=".15"/>';
        else if (p == 3) inner = '<circle cx="6" cy="6" r="2" fill="#fff" fill-opacity=".18"/><circle cx="18" cy="18" r="2" fill="#fff" fill-opacity=".18"/>';
        else if (p == 4) inner = '<circle cx="5" cy="7" r=".8" fill="#fff"/><circle cx="17" cy="15" r="1.2" fill="#fff"/><circle cx="20" cy="4" r=".6" fill="#fff"/>';
        return string.concat('<pattern id="p" width="24" height="24" patternUnits="userSpaceOnUse">', inner, "</pattern>");
    }

    function _patternName(uint8 p) private pure returns (string memory) {
        return p == 0 ? "Rays" : p == 1 ? "Grid" : p == 2 ? "Waves" : p == 3 ? "Hexagons" : p == 4 ? "Stars" : "Plain";
    }

    function _initial(string memory s) private pure returns (string memory) {
        bytes memory b = new bytes(1);
        b[0] = bytes(s)[0];
        if (b[0] >= 0x61 && b[0] <= 0x7A) b[0] = bytes1(uint8(b[0]) - 32);
        return string(b);
    }

    /// @dev "rrggbb" da bytes3 (Strings.toHexString aggiungerebbe "0x").
    function _hex3(bytes3 v) private pure returns (string memory) {
        bytes memory s = bytes(Strings.toHexString(uint256(uint24(v)), 3)); // "0xrrggbb"
        bytes memory out = new bytes(6);
        for (uint256 i; i < 6; ++i) out[i] = s[i + 2];
        return string(out);
    }
}
