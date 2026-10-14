// Port di is_declarable() di ygopro-core (playerop.cpp): decide se una carta
// può essere dichiarata in risposta a MSG_ANNOUNCE_CARD.
import { TYPE } from "./constants.js";

const OP = {
  ADD: 0x4000000000000000n, SUB: 0x4000000100000000n, MUL: 0x4000000200000000n,
  DIV: 0x4000000300000000n, AND: 0x4000000400000000n, OR: 0x4000000500000000n,
  NEG: 0x4000000600000000n, NOT: 0x4000000700000000n, BAND: 0x4000000800000000n,
  BOR: 0x4000000900000000n, BNOT: 0x4000001000000000n, BXOR: 0x4000001100000000n,
  LSHIFT: 0x4000001200000000n, RSHIFT: 0x4000001300000000n,
  ALLOW_ALIASES: 0x4000001400000000n, ALLOW_TOKENS: 0x4000001500000000n,
  ISCODE: 0x4000010000000000n, ISSETCARD: 0x4000010100000000n, ISTYPE: 0x4000010200000000n,
  ISRACE: 0x4000010300000000n, ISATTRIBUTE: 0x4000010400000000n, GETCODE: 0x4000010500000000n,
  GETSETCARD: 0x4000010600000000n, GETTYPE: 0x4000010700000000n, GETRACE: 0x4000010800000000n,
  GETATTRIBUTE: 0x4000010900000000n,
};
const MARINE_DOLPHIN = 78734254;
const TWINKLE_MOSS = 13857930;

const i64 = (v) => BigInt.asIntN(64, v);
const b = (x) => (x ? 1n : 0n);

export function isDeclarable(card, opcodes) {
  const stack = [];
  let alias = false;
  let token = false;
  const bin = (f) => {
    if (stack.length >= 2) {
      const rhs = stack.pop();
      const lhs = stack.pop();
      stack.push(i64(f(lhs, rhs)));
    }
  };
  const un = (f) => {
    if (stack.length >= 1) stack.push(i64(f(stack.pop())));
  };
  for (const raw of opcodes) {
    const op = BigInt.asUintN(64, BigInt(raw));
    switch (op) {
      case OP.ADD: bin((a, c) => a + c); break;
      case OP.SUB: bin((a, c) => a - c); break;
      case OP.MUL: bin((a, c) => a * c); break;
      case OP.DIV: bin((a, c) => (c === 0n ? 0n : a / c)); break;
      case OP.AND: bin((a, c) => b(a && c)); break;
      case OP.OR: bin((a, c) => b(a || c)); break;
      case OP.NEG: un((a) => -a); break;
      case OP.NOT: un((a) => b(!a)); break;
      case OP.BAND: bin((a, c) => a & c); break;
      case OP.BOR: bin((a, c) => a | c); break;
      case OP.BXOR: bin((a, c) => a ^ c); break;
      case OP.BNOT: un((a) => ~a); break;
      case OP.LSHIFT: bin((a, c) => a << c); break;
      case OP.RSHIFT: bin((a, c) => a >> c); break;
      case OP.ISCODE: un((a) => b(BigInt(card.code) === BigInt.asUintN(32, a))); break;
      case OP.ISTYPE: un((a) => BigInt(card.type) & a); break;
      case OP.ISRACE: un((a) => BigInt(card.race) & a); break;
      case OP.ISATTRIBUTE: un((a) => BigInt(card.attribute) & a); break;
      case OP.GETCODE: stack.push(BigInt(card.code)); break;
      case OP.GETTYPE: stack.push(BigInt(card.type)); break;
      case OP.GETRACE: stack.push(BigInt(card.race)); break;
      case OP.GETATTRIBUTE: stack.push(BigInt(card.attribute)); break;
      case OP.ISSETCARD:
        if (stack.length >= 1) {
          const setCode = Number(BigInt.asIntN(32, stack.pop()));
          const type = setCode & 0xfff;
          const sub = setCode & 0xf000;
          stack.push(b(card.setcodes.some((sc) => (sc & 0xfff) === type && (sc & 0xf000 & sub) === sub)));
        }
        break;
      case OP.ALLOW_ALIASES: alias = true; break;
      case OP.ALLOW_TOKENS: token = true; break;
      default: stack.push(i64(op));
    }
  }
  if (stack.length !== 1 || stack[0] === 0n) return false;
  const monsterToken = TYPE.MONSTER + TYPE.TOKEN;
  return (
    card.code === MARINE_DOLPHIN ||
    card.code === TWINKLE_MOSS ||
    ((alias || !card.alias) && (token || (card.type & monsterToken) !== monsterToken))
  );
}
