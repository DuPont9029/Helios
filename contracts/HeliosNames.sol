// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";
import { SSTORE2 } from "solady/src/utils/SSTORE2.sol";
import { HeliosCardRenderer, CardView, DeckView } from "./HeliosCard.sol";

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
///         La card mostra immagine del profilo, colori, wallet ETH e XMR e fino a 3 mazzi con la copertina: le immagini
///         (piccole, data URL PNG/JPEG/WebP controllati qui) stanno on-chain come codice di contratti dati (SSTORE2).
/// @dev Basato su OpenZeppelin Contracts 5.1.0 (ERC721, EIP712, Nonces, SignatureChecker) e Solady 0.1.26 (SSTORE2).
///      Il disegno (SVG e JSON) è in HeliosCardRenderer, creato dal constructor. Compilato per EVM "paris".
///      ABI e bytecode: src/data/names-contract.json (npm run contracts).
contract HeliosNames is ERC721, EIP712, Nonces {
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
        address avatar; // immagine del profilo (puntatore SSTORE2, zero se non c'è)
        string bio; // ASCII stampabile senza < > & " \ , al massimo 48 caratteri
        string xmr; // indirizzo Monero (o vuoto)
        Deck[] decks; // al massimo 3
    }

    struct Deck {
        string name;
        uint8 main;
        uint8 extra;
        address cover; // copertina (puntatore SSTORE2, zero se non c'è)
    }

    /// @notice Dati della card da coniare o aggiornare (immagini come data URL "data:image/…;base64,…").
    struct CardInput {
        bytes3 color;
        uint8 pattern;
        string bio;
        string xmr;
        bytes avatar;
        DeckInput[] decks;
    }

    struct DeckInput {
        string name;
        uint8 main;
        uint8 extra;
        bytes cover;
    }

    uint256 public constant MAX_AVATAR = 12000; // byte del data URL
    uint256 public constant MAX_COVER = 8000;
    uint256 public constant MAX_DECKS = 3;

    /// @notice Disegna la card (SVG e metadati): contratto senza stato creato nel constructor.
    HeliosCardRenderer public immutable renderer;

    uint256 public constant MIN_COMMIT_AGE = 60;
    uint256 public constant MAX_COMMIT_AGE = 1 days;

    // autorizzazioni firmate dal giocatore (EIP-712) quando paga un amico
    bytes32 private constant REGISTER_TYPEHASH = keccak256("Register(string name,bytes32 nostr,uint256 nonce,uint256 deadline)");
    // card = cardHash(input): impronta di tutti i dati della card (immagini comprese), che Helios mostra prima della firma
    bytes32 private constant MINT_TYPEHASH = keccak256("Mint(bytes32 card,uint256 nonce,uint256 deadline)");

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
    error BadImage();
    error BadMonero();
    error BadDecks();
    error CardExists();
    error BadSignature();
    error Expired();
    error Soulbound();

    constructor() ERC721("Helios Player Card", "HELIOS") EIP712("HeliosNames", "1") {
        renderer = new HeliosCardRenderer();
    }

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
    function mint(CardInput calldata card) external {
        _mintCard(msg.sender, card);
    }

    /// @notice Un amico paga il conio della card di `owner`, che ha firmato (EIP-712) l'impronta dei dati della card.
    function mintFor(address owner, CardInput calldata card, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(MINT_TYPEHASH, cardHash(card), _useNonce(owner), deadline)));
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert BadSignature();
        _mintCard(owner, card);
    }

    /// @notice Impronta dei dati di una card (quella che il giocatore firma per farla pagare a un amico).
    function cardHash(CardInput calldata c) public pure returns (bytes32) {
        bytes32[] memory decks = new bytes32[](c.decks.length);
        for (uint256 i; i < c.decks.length; ++i) {
            DeckInput calldata d = c.decks[i];
            decks[i] = keccak256(abi.encode(keccak256(bytes(d.name)), d.main, d.extra, keccak256(d.cover)));
        }
        return keccak256(abi.encode(c.color, c.pattern, keccak256(bytes(c.bio)), keccak256(bytes(c.xmr)), keccak256(c.avatar), keccak256(abi.encodePacked(decks))));
    }

    function _mintCard(address owner, CardInput calldata input) private {
        bytes32 key = keyOfOwner[owner];
        if (key == bytes32(0)) revert NotRegistered();
        uint256 id = uint256(key);
        if (_ownerOf(id) != address(0)) revert CardExists();
        _store(id, input);
        ++totalSupply;
        _mint(owner, id);
        emit Locked(id);
    }

    /// @notice Cambia i dati della propria card (immagini comprese).
    function setStyle(CardInput calldata input) external {
        uint256 id = uint256(keyOfOwner[msg.sender]);
        if (id == 0 || _ownerOf(id) != msg.sender) revert ERC721NonexistentToken(id);
        _store(id, input);
        emit CardStyled(id);
        emit MetadataUpdate(id);
    }

    /// EIP-4906: i marketplace ricaricano l'immagine quando cambia lo stile
    event MetadataUpdate(uint256 tokenId);

    /// @notice Dominio EIP-712 per le firme (comodo per i client).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @dev Controlla e salva i dati: testi sicuri per SVG e JSON, immagini come data URL validi (SSTORE2).
    function _store(uint256 id, CardInput calldata c) private {
        if (c.pattern > 5) revert BadPattern();
        _checkText(c.bio, 48);
        _checkMonero(c.xmr);
        if (c.decks.length > MAX_DECKS) revert BadDecks();
        Card storage card = _cards[id];
        card.color = c.color;
        card.pattern = c.pattern;
        card.bio = c.bio;
        card.xmr = c.xmr;
        card.avatar = _image(c.avatar, MAX_AVATAR);
        delete card.decks;
        for (uint256 i; i < c.decks.length; ++i) {
            DeckInput calldata d = c.decks[i];
            if (bytes(d.name).length == 0 || d.main > 60 || d.extra > 15) revert BadDecks();
            _checkText(d.name, 24);
            card.decks.push(Deck(d.name, d.main, d.extra, _image(d.cover, MAX_COVER)));
        }
    }

    /// @dev ASCII stampabile senza < > & " \ : resta valido dentro SVG e JSON senza escape.
    function _checkText(string calldata s, uint256 max) private pure {
        bytes calldata b = bytes(s);
        if (b.length > max) revert BadBio();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c < 0x20 || c > 0x7E || c == 0x3C || c == 0x3E || c == 0x26 || c == 0x22 || c == 0x5C) revert BadBio();
        }
    }

    /// @dev Vuoto, oppure 95 caratteri base58 che iniziano con 4 o 8 (indirizzo Monero standard o subaddress).
    function _checkMonero(string calldata s) private pure {
        bytes calldata b = bytes(s);
        if (b.length == 0) return;
        if (b.length != 95 || (b[0] != "4" && b[0] != "8")) revert BadMonero();
        for (uint256 i; i < 95; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "1" && c <= "9") || (c >= "A" && c <= "Z" && c != "I" && c != "O") || (c >= "a" && c <= "z" && c != "l");
            if (!ok) revert BadMonero();
        }
    }

    /// @dev Salva un'immagine (data URL PNG/JPEG/WebP in base64, al massimo `max` byte) con SSTORE2; zero se vuota.
    function _image(bytes calldata data, uint256 max) private returns (address) {
        if (data.length == 0) return address(0);
        if (data.length > max) revert BadImage();
        uint256 start = 0;
        if (_startsWith(data, "data:image/png;base64,")) start = 22;
        else if (_startsWith(data, "data:image/jpeg;base64,")) start = 23;
        else if (_startsWith(data, "data:image/webp;base64,")) start = 23;
        else revert BadImage();
        if (data.length == start) revert BadImage();
        for (uint256 i = start; i < data.length; ++i) {
            bytes1 c = data[i];
            bool ok = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "+" || c == "/" || c == "=";
            if (!ok) revert BadImage();
        }
        return SSTORE2.write(data);
    }

    function _startsWith(bytes calldata data, bytes memory prefix) private pure returns (bool) {
        if (data.length < prefix.length) return false;
        for (uint256 i; i < prefix.length; ++i) if (data[i] != prefix[i]) return false;
        return true;
    }

    /// @notice Dati della card di un wallet (tokenId 0 se non l'ha), immagini comprese.
    function cardOf(address owner) external view returns (uint256 tokenId, CardView memory card) {
        tokenId = uint256(keyOfOwner[owner]);
        if (tokenId == 0 || _ownerOf(tokenId) == address(0)) return (0, card);
        card = _view(tokenId);
    }

    function _view(uint256 id) private view returns (CardView memory v) {
        Name storage n = _names[bytes32(id)];
        Card storage c = _cards[id];
        v.name = n.display;
        v.number = n.number;
        v.og = n.number <= OG_LIMIT;
        v.nostr = n.nostr;
        v.owner = n.owner;
        v.since = n.block_;
        v.color = c.color;
        v.pattern = c.pattern;
        v.bio = c.bio;
        v.xmr = c.xmr;
        if (c.avatar != address(0)) v.avatar = SSTORE2.read(c.avatar);
        v.decks = new DeckView[](c.decks.length);
        for (uint256 i; i < c.decks.length; ++i) {
            Deck storage d = c.decks[i];
            v.decks[i] = DeckView(d.name, d.main, d.extra, d.cover != address(0) ? SSTORE2.read(d.cover) : bytes(""));
        }
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

    /// @notice Metadati e immagine della card (JSON e SVG in base64), disegnati da HeliosCardRenderer.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return renderer.tokenURI(_view(tokenId));
    }
}
