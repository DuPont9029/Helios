// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Dati di una player card come li disegna HeliosCardRenderer (letti da HeliosNames, immagini comprese).
/// @dev Tutti i testi e le immagini sono già controllati da HeliosNames quando si salvano: nomi [A-Za-z0-9_], frase e
///      nomi dei mazzi in ASCII stampabile senza < > & " \ , XMR in base58, immagini "data:image/(png|jpeg|webp);base64,"
///      con soli caratteri base64. Così restano validi dentro SVG e JSON senza escape.
struct CardView {
    string name;
    uint32 number;
    bool og;
    bytes32 nostr;
    address owner;
    uint64 since; // blocco della registrazione
    bytes3 color;
    uint8 pattern;
    string bio;
    string xmr;
    bytes avatar; // data URL o vuoto
    DeckView[] decks;
}

struct DeckView {
    string name;
    uint8 main;
    uint8 extra;
    bytes cover; // data URL o vuoto
}

/// @title Disegno della Helios player card (SVG e metadati JSON)
/// @notice Contratto senza stato, creato da HeliosNames nel suo constructor: riceve i dati della card e restituisce il
///         tokenURI. Separato solo per stare nel limite di 24 KB di codice per contratto (EIP-170).
contract HeliosCardRenderer {
    using Strings for uint256;

    /// @notice tokenURI completo: "data:application/json;base64,…" con l'immagine SVG dentro.
    function tokenURI(CardView calldata c) external pure returns (string memory) {
        string memory image = string.concat('"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg(c))), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(string.concat(_meta(c), image))));
    }

    function _meta(CardView calldata c) private pure returns (string memory) {
        string memory num = uint256(c.number).toString();
        return string.concat(
            '{"name":"#', num, " ", c.name, ' - Helios Player Card","description":"Helios username #', num,
            c.og ? " (OG)." : ".", bytes(c.bio).length > 0 ? string.concat(" ", c.bio) : "",
            '","attributes":[{"trait_type":"Number","display_type":"number","value":', num,
            '},{"trait_type":"OG","value":"', c.og ? "Yes" : "No",
            '"},{"trait_type":"Pattern","value":"', _patternName(c.pattern),
            '"},{"trait_type":"Decks","value":', uint256(c.decks.length).toString(), "}],"
        );
    }

    /// @notice Solo l'immagine SVG (400 × 640).
    function svg(CardView calldata c) public pure returns (string memory) {
        string memory col = string.concat("#", _hex3(c.color));
        return string.concat(_frame(c.pattern, col), _top(c, col), _body(c, col), _decks(c, col), _footer(c, col), "</svg>");
    }

    function _frame(uint8 pattern, string memory col) private pure returns (string memory) {
        string memory defs = string.concat(
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="', col,
            '"/><stop offset="1" stop-color="#0b0c12"/></linearGradient>', _pattern(pattern),
            '<clipPath id="c"><rect x="1.5" y="1.5" width="397" height="637" rx="22"/></clipPath>',
            '<clipPath id="a"><circle cx="200" cy="170" r="62"/></clipPath></defs>'
        );
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 640" font-family="monospace">', defs,
            '<rect x="1.5" y="1.5" width="397" height="637" rx="22" fill="#11131c"/>',
            '<g clip-path="url(#c)"><rect width="400" height="170" fill="url(#g)"/><rect width="400" height="170" fill="url(#p)"/></g>',
            '<rect x="1.5" y="1.5" width="397" height="637" rx="22" fill="none" stroke="', col, '" stroke-width="3"/>'
        );
    }

    /// @dev Logo, numero (con OG) e immagine del profilo (o l'iniziale).
    function _top(CardView calldata c, string memory col) private pure returns (string memory) {
        string memory num = string.concat("#", uint256(c.number).toString());
        string memory badge = string.concat(
            '<text x="28" y="44" fill="#fff" font-size="20" font-weight="700" letter-spacing="4">HELI<tspan fill="', col, '">OS</tspan></text>',
            '<rect x="268" y="22" width="110" height="34" rx="17" fill="#0b0c12" fill-opacity=".75" stroke="', col, '"/>',
            '<text x="323" y="45" fill="#fff" font-size="18" font-weight="700" text-anchor="middle">', num, "</text>",
            c.og ? '<rect x="296" y="62" width="54" height="22" rx="4" fill="#ffcf3b"/><text x="323" y="78" fill="#0b0c12" font-size="14" font-weight="700" text-anchor="middle" letter-spacing="2">OG</text>' : ""
        );
        string memory face = c.avatar.length > 0
            ? string.concat('<image href="', string(c.avatar), '" x="138" y="108" width="124" height="124" preserveAspectRatio="xMidYMid slice" clip-path="url(#a)"/>')
            : string.concat('<text x="200" y="192" fill="', col, '" font-size="60" font-weight="700" text-anchor="middle">', _initial(c.name), "</text>");
        return string.concat(badge, '<circle cx="200" cy="170" r="66" fill="#11131c" stroke="', col, '" stroke-width="5"/>', face);
    }

    function _body(CardView calldata c, string memory col) private pure returns (string memory) {
        return string.concat(
            '<text x="200" y="272" fill="#fff" font-size="28" font-weight="700" text-anchor="middle">', c.name, "</text>",
            '<text x="200" y="300" fill="#c9cfdc" font-size="12" text-anchor="middle" font-style="italic">', c.bio, "</text>",
            '<line x1="32" y1="318" x2="368" y2="318" stroke="', col, '" stroke-opacity=".5"/>',
            _row(342, "ETH", string.concat(Strings.toHexString(uint256(uint48(bytes6(bytes20(c.owner)))), 6), "...", _tail(Strings.toHexString(c.owner), 4))),
            _row(364, "XMR", bytes(c.xmr).length > 0 ? string.concat(_head(c.xmr, 8), "...", _tail(c.xmr, 6)) : "-"),
            _row(386, "NOSTR", string.concat(Strings.toHexString(uint256(uint48(bytes6(c.nostr))), 6), "...")),
            _row(408, "SINCE", string.concat("block ", uint256(c.since).toString()))
        );
    }

    function _row(uint256 y, string memory label, string memory value) private pure returns (string memory) {
        string memory ys = y.toString();
        return string.concat(
            '<text x="32" y="', ys, '" fill="#8b93a7" font-size="11">', label, '</text><text x="368" y="', ys,
            '" fill="#e6ecf5" font-size="11" text-anchor="end">', value, "</text>"
        );
    }

    /// @dev Fino a 3 mazzi: copertina (se c'è), nome e numero di carte.
    function _decks(CardView calldata c, string memory col) private pure returns (string memory out) {
        uint256 n = c.decks.length;
        if (n == 0) return "";
        out = string.concat('<text x="32" y="438" fill="#8b93a7" font-size="11" letter-spacing="2">DECKS</text>');
        for (uint256 i; i < n; ++i) out = string.concat(out, _deck(c.decks[i], 32 + i * 116, col));
    }

    function _deck(DeckView calldata d, uint256 x, string memory col) private pure returns (string memory) {
        string memory xs = x.toString();
        string memory cx = (x + 52).toString();
        string memory art = d.cover.length > 0
            ? string.concat('<image href="', string(d.cover), '" x="', (x + 22).toString(), '" y="448" width="60" height="88" preserveAspectRatio="xMidYMid slice"/>')
            : string.concat('<rect x="', (x + 22).toString(), '" y="448" width="60" height="88" rx="4" fill="#1d2030" stroke="', col, '" stroke-opacity=".4"/>');
        return string.concat(
            '<rect x="', xs, '" y="444" width="104" height="132" rx="8" fill="#0b0c12" fill-opacity=".5"/>', art,
            '<text x="', cx, '" y="554" fill="#fff" font-size="11" font-weight="700" text-anchor="middle">', d.name, "</text>",
            '<text x="', cx, '" y="569" fill="#8b93a7" font-size="10" text-anchor="middle">', uint256(d.main).toString(), "+", uint256(d.extra).toString(), "</text>"
        );
    }

    function _footer(CardView calldata c, string memory col) private pure returns (string memory) {
        return string.concat(
            '<text x="32" y="612" fill="', col, '" font-size="14" font-weight="700">USERNAME #', uint256(c.number).toString(), c.og ? " - OG" : "", "</text>",
            '<text x="368" y="612" fill="#8b93a7" font-size="12" text-anchor="end">ygoweb.eu</text>'
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

    function _head(string memory s, uint256 n) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length <= n) return s;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = b[i];
        return string(out);
    }

    function _tail(string memory s, uint256 n) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length <= n) return s;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = b[b.length - n + i];
        return string(out);
    }

    /// @dev "rrggbb" da bytes3 (Strings.toHexString aggiungerebbe "0x").
    function _hex3(bytes3 v) private pure returns (string memory) {
        return _tail(Strings.toHexString(uint256(uint24(v)), 3), 6);
    }
}
