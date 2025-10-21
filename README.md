# bigint-runtime

A functional-style BigInt runtime library for JavaScript, **refactored from JSBI**. This library is a modified version of the original JSBI library, transforming its object-oriented approach with static methods into a more tree-shakeable, functional programming style using named exports.

> **Note**: This library is based on [GoogleChromeLabs/jsbi](https://github.com/GoogleChromeLabs/jsbi), retaining all of JSBI's functionality but with a more modern functional API design.

## Features

- Functional programming style with `export function` instead of static methods
- All the functionality of JSBI in a more tree-shakeable format
- TypeScript support with complete type definitions
- Modern JavaScript module formats (ESM, CommonJS, UMD)

## Installation

```bash
npm install bigint-runtime
```

## Usage

```javascript
// jsbi usage
import JSBI from 'jsbi';
```

```javascript
// bigint-runtime usage
import * as JSBI from 'bigint-runtime';
```

## Example

```javascript
import * as JSBI from 'bigint-runtime';

const max = JSBI.BigInt(Number.MAX_SAFE_INTEGER);
console.log(String(max));
// → '9007199254740991'
const other = JSBI.BigInt('2');
const result = JSBI.add(max, other);
console.log(String(result));
// → '9007199254740993'
```

Note: explicitly call `toString` on any `JSBI` instances when `console.log()`ing them to see their numeric representation (e.g. `String(max)` or `max.toString()`). Without it (e.g. `console.log(max)`), you’ll instead see the object that represents the value.

## How?

Except for mechanical differences in syntax, you use JSBI-BigInts just [like you would use native BigInts](https://developers.google.com/web/updates/2018/05/bigint). Some things even look the same, after you replace `BigInt` with `JSBI.BigInt`:

| Operation            | native BigInts          | JSBI                     |
| -------------------- | ----------------------- | ------------------------ |
| Creation from String | `a = BigInt('456')`     | `a = JSBI.BigInt('456')` |
| Creation from Number | `a = BigInt(789)`       | `a = JSBI.BigInt(789)`   |
| Conversion to String | `a.toString(radix)`     | `a.toString(radix)`      |
| Conversion to Number | `Number(a)`             | `JSBI.toNumber(a)`       |
| Truncation           | `BigInt.asIntN(64, a)`  | `JSBI.asIntN(64, a)`     |
|                      | `BigInt.asUintN(64, a)` | `JSBI.asUintN(64, a)`    |
| Type check           | `typeof a === 'bigint'` | `a instanceof JSBI`      |

Most operators are replaced by static functions:

| Operation                   | native BigInts | JSBI                              |
| --------------------------- | -------------- | --------------------------------- |
| Addition                    | `c = a + b`    | `c = JSBI.add(a, b)`              |
| Subtraction                 | `c = a - b`    | `c = JSBI.subtract(a, b)`         |
| Multiplication              | `c = a * b`    | `c = JSBI.multiply(a, b)`         |
| Division                    | `c = a / b`    | `c = JSBI.divide(a, b)`           |
| Remainder                   | `c = a % b`    | `c = JSBI.remainder(a, b)`        |
| Exponentiation              | `c = a ** b`   | `c = JSBI.exponentiate(a, b)`     |
| Negation                    | `b = -a`       | `b = JSBI.unaryMinus(a)`          |
| Bitwise negation            | `b = ~a`       | `b = JSBI.bitwiseNot(a)`          |
| Left shifting               | `c = a << b`   | `c = JSBI.leftShift(a, b)`        |
| Right shifting              | `c = a >> b`   | `c = JSBI.signedRightShift(a, b)` |
| Bitwise “and”               | `c = a & b`    | `c = JSBI.bitwiseAnd(a, b)`       |
| Bitwise “or”                | `c = a \| b`   | `c = JSBI.bitwiseOr(a, b)`        |
| Bitwise “xor”               | `c = a ^ b`    | `c = JSBI.bitwiseXor(a, b)`       |
| Comparison to other BigInts | `a === b`      | `JSBI.equal(a, b)`                |
|                             | `a !== b`      | `JSBI.notEqual(a, b)`             |
|                             | `a < b`        | `JSBI.lessThan(a, b)`             |
|                             | `a <= b`       | `JSBI.lessThanOrEqual(a, b)`      |
|                             | `a > b`        | `JSBI.greaterThan(a, b)`          |
|                             | `a >= b`       | `JSBI.greaterThanOrEqual(a, b)`   |

The functions above operate only on BigInts. (They don’t perform type checks in the current implementation, because such checks are a waste of time when we assume that you know what you’re doing. Don’t try to call them with other inputs, or you’ll get “interesting” failures!)

Some operations are particularly interesting when you give them inputs of mixed types, e.g. comparing a BigInt to a Number, or concatenating a string with a BigInt. They are implemented as static functions named after the respective native operators:

| Operation                       | native BigInts | JSBI             |
| ------------------------------- | -------------- | ---------------- |
| Abstract equality comparison    | `x == y`       | `JSBI.EQ(x, y)`  |
| Generic “not equal”             | `x != y`       | `JSBI.NE(x, y)`  |
| Generic “less than”             | `x < y`        | `JSBI.LT(x, y)`  |
| Generic “less than or equal”    | `x <= y`       | `JSBI.LE(x, y)`  |
| Generic “greater than”          | `x > y`        | `JSBI.GT(x, y)`  |
| Generic “greater than or equal” | `x >= y`       | `JSBI.GE(x, y)`  |
| Generic addition                | `x + y`        | `JSBI.ADD(x, y)` |

The variable names `x` and `y` here indicate that the variables can refer to anything, for example: `JSBI.GT(101.5, BigInt('100'))` or `str = JSBI.ADD('result: ', BigInt('0x2A'))`.

Unfortunately, there are also a few things that are not supported at all:

| Unsupported operation | native BigInts | JSBI                                 |
| --------------------- | -------------- | ------------------------------------ |
| literals              | `a = 123n;`    | N/A ☹                                |
| increment             | `a++`          | N/A ☹                                |
|                       | `a + 1n`       | `JSBI.add(a, JSBI.BigInt('1'))`      |
| decrement             | `a--`          | N/A ☹                                |
|                       | `a - 1n`       | `JSBI.subtract(a, JSBI.BigInt('1'))` |

It is impossible to replicate the exact behavior of the native `++` and `--` operators in a polyfill/library. Since JSBI is intended to be transpiled away eventually, it doesn’t provide a similar-but-different alternative. You can use `JSBI.add()` and `JSBI.subtract()` instead.

Since version 4.2.0, polyfills for `DataView` operations are included (where `dv` is a `DataView`, `i` is an index, `le` is an optional boolean indicating little endian mode, and `x` is a `BigInt` or a `JSBI` instance, respectively):

| native BigInts/DataViews    | JSBI                                      |
|-----------------------------|-------------------------------------------|
| `dv.getBigInt64(i, le)`     | `JSBI.DataViewGetBigInt64(dv, i, le)`     |
| `dv.setBigInt64(i, x, le)`  | `JSBI.DataViewSetBigInt64(dv, i, x, le)`  |
| `dv.getBigUint64(i, le)`    | `JSBI.DataViewGetBigUint64(dv, i, le)`    |
| `dv.setBigUint64(i, x, le)` | `JSBI.DataViewSetBigUint64(dv, i, x, le)` |

## License

Same as JSBI, this library is licensed under the Apache License 2.0.
