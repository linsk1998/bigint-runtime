// Copyright 2018 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the “License”);
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// <https://apache.org/licenses/LICENSE-2.0>.
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an “AS IS” BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

export class JSBI extends Array {
	constructor(length: number, public sign: boolean) {
		super(length);
		// Explicitly set the prototype as per
		// https://github.com/Microsoft/TypeScript-wiki/blob/main/Breaking-Changes.md#extending-built-ins-like-error-array-and-map-may-no-longer-work
		Object.setPrototypeOf(this, JSBI.prototype);
		if(length > __kMaxLength) {
			throw new RangeError('Maximum BigInt size exceeded');
		}
	}

	// toDebugString(): string {
	// 	const result = ['BigInt['];
	// 	for(const digit of this) {
	// 		result.push((digit ? (digit >>> 0).toString(16) : digit) + ', ');
	// 	}
	// 	result.push(']');
	// 	return result.join('');
	// }

	override toString(radix: number = 10): string {
		if(radix < 2 || radix > 36) {
			throw new RangeError(
				'toString() radix argument must be between 2 and 36');
		}
		if(this.length === 0) return '0';
		if((radix & (radix - 1)) === 0) {
			return __toStringBasePowerOfTwo(this, radix);
		}
		return __toStringGeneric(this, radix, false);
	}

	override valueOf() {
		throw new Error('Convert JSBI instances to native numbers using `toNumber`.');
	}

	// Digit helpers.
	__digit(i: number): number {
		return this[i];
	}
	__unsignedDigit(i: number): number {
		return this[i] >>> 0;
	}
	__setDigit(i: number, digit: number): void {
		this[i] = digit | 0;
	}
	__setDigitGrow(i: number, digit: number): void {
		this[i] = digit | 0;
	}
	__halfDigitLength(): number {
		const len = this.length;
		if(this.__unsignedDigit(len - 1) <= 0x7FFF) return len * 2 - 1;
		return len * 2;
	}
	__halfDigit(i: number): number {
		return (this[i >>> 1] >>> ((i & 1) * 15)) & 0x7FFF;
	}
	__setHalfDigit(i: number, value: number): void {
		const digitIndex = i >>> 1;
		const previous = this.__digit(digitIndex);
		const updated = (i & 1) ? (previous & 0x7FFF) | (value << 15) :
			(previous & 0x3FFF8000) | (value & 0x7FFF);
		this.__setDigit(digitIndex, updated);
	}
}

export function BigInt(arg: number | string | boolean | object): JSBI {
	if(typeof arg === 'number') {
		if(arg === 0) return __zero();
		if(__isOneDigitInt(arg)) {
			if(arg < 0) {
				return __oneDigit(-arg, true);
			}
			return __oneDigit(arg, false);
		}
		if(!Number.isFinite(arg) || Math.floor(arg) !== arg) {
			throw new RangeError('The number ' + arg + ' cannot be converted to ' +
				'BigInt because it is not an integer');
		}
		return __fromDouble(arg);
	} else if(typeof arg === 'string') {
		const result = __fromString(arg);
		if(result === null) {
			throw new SyntaxError('Cannot convert ' + arg + ' to a BigInt');
		}
		return result;
	} else if(typeof arg === 'boolean') {
		if(arg === true) {
			return __oneDigit(1, false);
		}
		return __zero();
	} else if(typeof arg === 'object') {
		if(arg.constructor === JSBI) return arg;
		const primitive = __toPrimitive(arg);
		return BigInt(primitive);
	}
	throw new TypeError('Cannot convert ' + arg + ' to a BigInt');
}


// Equivalent of "Number(my_bigint)" in the native implementation.
// TODO: add more tests
export function toNumber(x: JSBI): number {
	const xLength = x.length;
	if(xLength === 0) return 0;
	if(xLength === 1) {
		const value = x.__unsignedDigit(0);
		return x.sign ? -value : value;
	}
	const xMsd = x.__digit(xLength - 1);
	const msdLeadingZeros = __clz30(xMsd);
	const xBitLength = xLength * 30 - msdLeadingZeros;
	if(xBitLength > 1024) return x.sign ? -Infinity : Infinity;
	let exponent = xBitLength - 1;
	let currentDigit = xMsd;
	let digitIndex = xLength - 1;
	const shift = msdLeadingZeros + 3;
	let mantissaHigh = (shift === 32) ? 0 : currentDigit << shift;
	mantissaHigh >>>= 12;
	const mantissaHighBitsUnset = shift - 12;
	let mantissaLow = (shift >= 12) ? 0 : (currentDigit << (20 + shift));
	let mantissaLowBitsUnset = 20 + shift;
	if(mantissaHighBitsUnset > 0 && digitIndex > 0) {
		digitIndex--;
		currentDigit = x.__digit(digitIndex);
		mantissaHigh |= (currentDigit >>> (30 - mantissaHighBitsUnset));
		mantissaLow = currentDigit << mantissaHighBitsUnset + 2;
		mantissaLowBitsUnset = mantissaHighBitsUnset + 2;
	}
	while(mantissaLowBitsUnset > 0 && digitIndex > 0) {
		digitIndex--;
		currentDigit = x.__digit(digitIndex);
		if(mantissaLowBitsUnset >= 30) {
			mantissaLow |= (currentDigit << (mantissaLowBitsUnset - 30));
		} else {
			mantissaLow |= (currentDigit >>> (30 - mantissaLowBitsUnset));
		}
		mantissaLowBitsUnset -= 30;
	}
	const rounding = __decideRounding(x, mantissaLowBitsUnset,
		digitIndex, currentDigit);
	if(rounding === 1 || (rounding === 0 && (mantissaLow & 1) === 1)) {
		mantissaLow = (mantissaLow + 1) >>> 0;
		if(mantissaLow === 0) {
			// Incrementing mantissaLow overflowed.
			mantissaHigh++;
			if((mantissaHigh >>> 20) !== 0) {
				// Incrementing mantissaHigh overflowed.
				mantissaHigh = 0;
				exponent++;
				if(exponent > 1023) {
					// Incrementing the exponent overflowed.
					return x.sign ? -Infinity : Infinity;
				}
			}
		}
	}
	const signBit = x.sign ? (1 << 31) : 0;
	exponent = (exponent + 0x3FF) << 20;
	__kBitConversionInts[__kBitConversionIntHigh] =
		signBit | exponent | mantissaHigh;
	__kBitConversionInts[__kBitConversionIntLow] = mantissaLow;
	return __kBitConversionDouble[0];
}

// Operations.

export function unaryMinus(x: JSBI): JSBI {
	if(x.length === 0) return x;
	const result = __copy(x);
	result.sign = !x.sign;
	return result;
}

export function bitwiseNot(x: JSBI): JSBI {
	if(x.sign) {
		// ~(-x) == ~(~(x-1)) == x-1
		return __trim(__absoluteSubOne(x));
	}
	// ~x == -x-1 == -(x+1)
	return __absoluteAddOne(x, true);
}

export function exponentiate(x: JSBI, y: JSBI): JSBI {
	if(y.sign) {
		throw new RangeError('Exponent must be positive');
	}
	if(y.length === 0) {
		return __oneDigit(1, false);
	}
	if(x.length === 0) return x;
	if(x.length === 1 && x.__digit(0) === 1) {
		// (-1) ** even_number == 1.
		if(x.sign && (y.__digit(0) & 1) === 0) {
			return unaryMinus(x);
		}
		// (-1) ** odd_number == -1, 1 ** anything == 1.
		return x;
	}
	// For all bases >= 2, very large exponents would lead to unrepresentable
	// results.
	if(y.length > 1) throw new RangeError('BigInt too big');
	let expValue = y.__unsignedDigit(0);
	if(expValue === 1) return x;
	if(expValue >= __kMaxLengthBits) {
		throw new RangeError('BigInt too big');
	}
	if(x.length === 1 && x.__digit(0) === 2) {
		// Fast path for 2^n.
		const neededDigits = 1 + ((expValue / 30) | 0);
		const sign = x.sign && ((expValue & 1) !== 0);
		const result = new JSBI(neededDigits, sign);
		__initializeDigits(result);
		// All bits are zero. Now set the n-th bit.
		const msd = 1 << (expValue % 30);
		result.__setDigit(neededDigits - 1, msd);
		return result;
	}
	let result = null;
	let runningSquare = x;
	// This implicitly sets the result's sign correctly.
	if((expValue & 1) !== 0) result = x;
	expValue >>= 1;
	for(; expValue !== 0; expValue >>= 1) {
		runningSquare = multiply(runningSquare, runningSquare);
		if((expValue & 1) !== 0) {
			if(result === null) {
				result = runningSquare;
			} else {
				result = multiply(result, runningSquare);
			}
		}
	}
	// TODO see if there's a way for tsc to infer this will always happen?
	return result as JSBI;
}

export function multiply(x: JSBI, y: JSBI): JSBI {
	if(x.length === 0) return x;
	if(y.length === 0) return y;
	let resultLength = x.length + y.length;
	if(__clzmsd(x) + __clzmsd(y) >= 30) {
		resultLength--;
	}
	const result = new JSBI(resultLength, x.sign !== y.sign);
	__initializeDigits(result);
	for(let i = 0; i < x.length; i++) {
		__multiplyAccumulate(y, x.__digit(i), result, i);
	}
	return __trim(result);
}


export function divide(x: JSBI, y: JSBI): JSBI {
	if(y.length === 0) throw new RangeError('Division by zero');
	if(__absoluteCompare(x, y) < 0) return __zero();
	const resultSign = x.sign !== y.sign;
	const divisor = y.__unsignedDigit(0);
	let quotient;
	if(y.length === 1 && divisor <= 0x7FFF) {
		if(divisor === 1) {
			return resultSign === x.sign ? x : unaryMinus(x);
		}
		quotient = __absoluteDivSmall(x, divisor, null);
	} else {
		quotient = __absoluteDivLarge(x, y, true, false);
	}
	quotient.sign = resultSign;
	return __trim(quotient);
}

export function remainder(x: JSBI, y: JSBI): JSBI {
	if(y.length === 0) throw new RangeError('Division by zero');
	if(__absoluteCompare(x, y) < 0) return x;
	const divisor = y.__unsignedDigit(0);
	if(y.length === 1 && divisor <= 0x7FFF) {
		if(divisor === 1) return __zero();
		const remainderDigit = __absoluteModSmall(x, divisor);
		if(remainderDigit === 0) return __zero();
		return __oneDigit(remainderDigit, x.sign);
	}
	const remainder = __absoluteDivLarge(x, y, false, true);
	remainder.sign = x.sign;
	return __trim(remainder);
}

export function add(x: JSBI, y: JSBI): JSBI {
	const sign = x.sign;
	if(sign === y.sign) {
		// x + y == x + y
		// -x + -y == -(x + y)
		return __absoluteAdd(x, y, sign);
	}
	// x + -y == x - y == -(y - x)
	// -x + y == y - x == -(x - y)
	if(__absoluteCompare(x, y) >= 0) {
		return __absoluteSub(x, y, sign);
	}
	return __absoluteSub(y, x, !sign);
}

export function subtract(x: JSBI, y: JSBI): JSBI {
	const sign = x.sign;
	if(sign !== y.sign) {
		// x - (-y) == x + y
		// (-x) - y == -(x + y)
		return __absoluteAdd(x, y, sign);
	}
	// x - y == -(y - x)
	// (-x) - (-y) == y - x == -(x - y)
	if(__absoluteCompare(x, y) >= 0) {
		return __absoluteSub(x, y, sign);
	}
	return __absoluteSub(y, x, !sign);
}



export function leftShift(x: JSBI, y: JSBI): JSBI {
	if(y.length === 0 || x.length === 0) return x;
	if(y.sign) return __rightShiftByAbsolute(x, y);
	return __leftShiftByAbsolute(x, y);
}

export function signedRightShift(x: JSBI, y: JSBI): JSBI {
	if(y.length === 0 || x.length === 0) return x;
	if(y.sign) return __leftShiftByAbsolute(x, y);
	return __rightShiftByAbsolute(x, y);
}

export function unsignedRightShift() {
	throw new TypeError(
		'BigInts have no unsigned right shift; use >> instead');
}

export function lessThan(x: JSBI, y: JSBI): boolean {
	return __compareToBigInt(x, y) < 0;
}

export function lessThanOrEqual(x: JSBI, y: JSBI): boolean {
	return __compareToBigInt(x, y) <= 0;
}

export function greaterThan(x: JSBI, y: JSBI): boolean {
	return __compareToBigInt(x, y) > 0;
}

export function greaterThanOrEqual(x: JSBI, y: JSBI): boolean {
	return __compareToBigInt(x, y) >= 0;
}

export function equal(x: JSBI, y: JSBI): boolean {
	if(x.sign !== y.sign) return false;
	if(x.length !== y.length) return false;
	for(let i = 0; i < x.length; i++) {
		if(x.__digit(i) !== y.__digit(i)) return false;
	}
	return true;
}

export function notEqual(x: JSBI, y: JSBI): boolean {
	return !equal(x, y);
}

export function bitwiseAnd(x: JSBI, y: JSBI): JSBI {
	if(!x.sign && !y.sign) {
		return __trim(__absoluteAnd(x, y));
	} else if(x.sign && y.sign) {
		const resultLength = Math.max(x.length, y.length) + 1;
		// (-x) & (-y) == ~(x-1) & ~(y-1) == ~((x-1) | (y-1))
		// == -(((x-1) | (y-1)) + 1)
		let result = __absoluteSubOne(x, resultLength);
		const y1 = __absoluteSubOne(y);
		result = __absoluteOr(result, y1, result);
		return __trim(__absoluteAddOne(result, true, result));
	}
	// Assume that x is the positive BigInt.
	if(x.sign) {
		[x, y] = [y, x];
	}
	// x & (-y) == x & ~(y-1) == x &~ (y-1)
	return __trim(__absoluteAndNot(x, __absoluteSubOne(y)));
}

export function bitwiseXor(x: JSBI, y: JSBI): JSBI {
	if(!x.sign && !y.sign) {
		return __trim(__absoluteXor(x, y));
	} else if(x.sign && y.sign) {
		// (-x) ^ (-y) == ~(x-1) ^ ~(y-1) == (x-1) ^ (y-1)
		const resultLength = Math.max(x.length, y.length);
		const result = __absoluteSubOne(x, resultLength);
		const y1 = __absoluteSubOne(y);
		return __trim(__absoluteXor(result, y1, result));
	}
	const resultLength = Math.max(x.length, y.length) + 1;
	// Assume that x is the positive BigInt.
	if(x.sign) {
		[x, y] = [y, x];
	}
	// x ^ (-y) == x ^ ~(y-1) == ~(x ^ (y-1)) == -((x ^ (y-1)) + 1)
	let result = __absoluteSubOne(y, resultLength);
	result = __absoluteXor(result, x, result);
	return __trim(__absoluteAddOne(result, true, result));
}

export function bitwiseOr(x: JSBI, y: JSBI): JSBI {
	const resultLength = Math.max(x.length, y.length);
	if(!x.sign && !y.sign) {
		return __trim(__absoluteOr(x, y));
	} else if(x.sign && y.sign) {
		// (-x) | (-y) == ~(x-1) | ~(y-1) == ~((x-1) & (y-1))
		// == -(((x-1) & (y-1)) + 1)
		let result = __absoluteSubOne(x, resultLength);
		const y1 = __absoluteSubOne(y);
		result = __absoluteAnd(result, y1, result);
		return __trim(__absoluteAddOne(result, true, result));
	}
	// Assume that x is the positive BigInt.
	if(x.sign) {
		[x, y] = [y, x];
	}
	// x | (-y) == x | ~(y-1) == ~((y-1) &~ x) == -(((y-1) ~& x) + 1)
	let result = __absoluteSubOne(y, resultLength);
	result = __absoluteAndNot(result, x, result);
	return __trim(__absoluteAddOne(result, true, result));
}

export function asIntN(n: number, x: JSBI): JSBI {
	if(x.length === 0) return x;
	n = Math.floor(n);
	if(n < 0) {
		throw new RangeError(
			'Invalid value: not (convertible to) a safe integer');
	}
	if(n === 0) return __zero();
	// If {x} has less than {n} bits, return it directly.
	if(n >= __kMaxLengthBits) return x;
	const neededLength = ((n + 29) / 30) | 0;
	if(x.length < neededLength) return x;
	const topDigit = x.__unsignedDigit(neededLength - 1);
	const compareDigit = 1 << ((n - 1) % 30);
	if(x.length === neededLength && topDigit < compareDigit) return x;
	// Otherwise truncate and simulate two's complement.
	const hasBit = (topDigit & compareDigit) === compareDigit;
	if(!hasBit) return __truncateToNBits(n, x);
	if(!x.sign) return __truncateAndSubFromPowerOfTwo(n, x, true);
	if((topDigit & (compareDigit - 1)) === 0) {
		for(let i = neededLength - 2; i >= 0; i--) {
			if(x.__digit(i) !== 0) {
				return __truncateAndSubFromPowerOfTwo(n, x, false);
			}
		}
		if(x.length === neededLength && topDigit === compareDigit) return x;
		return __truncateToNBits(n, x);
	}
	return __truncateAndSubFromPowerOfTwo(n, x, false);
}

export function asUintN(n: number, x: JSBI): JSBI {
	if(x.length === 0) return x;
	n = Math.floor(n);
	if(n < 0) {
		throw new RangeError(
			'Invalid value: not (convertible to) a safe integer');
	}
	if(n === 0) return __zero();
	// If {x} is negative, simulate two's complement representation.
	if(x.sign) {
		if(n > __kMaxLengthBits) {
			throw new RangeError('BigInt too big');
		}
		return __truncateAndSubFromPowerOfTwo(n, x, false);
	}
	// If {x} is positive and has up to {n} bits, return it directly.
	if(n >= __kMaxLengthBits) return x;
	const neededLength = ((n + 29) / 30) | 0;
	if(x.length < neededLength) return x;
	const bitsInTopDigit = n % 30;
	if(x.length == neededLength) {
		if(bitsInTopDigit === 0) return x;
		const topDigit = x.__digit(neededLength - 1);
		if((topDigit >>> bitsInTopDigit) === 0) return x;
	}
	// Otherwise, truncate.
	return __truncateToNBits(n, x);
}

// Operators.

export function ADD(x: any, y: any) {
	x = __toPrimitive(x);
	y = __toPrimitive(y);
	if(typeof x === 'string') {
		if(typeof y !== 'string') y = y.toString();
		return x + y;
	}
	if(typeof y === 'string') {
		return x.toString() + y;
	}
	x = __toNumeric(x);
	y = __toNumeric(y);
	if(__isBigInt(x) && __isBigInt(y)) {
		return add(x, y);
	}
	if(typeof x === 'number' && typeof y === 'number') {
		return x + y;
	}
	throw new TypeError(
		'Cannot mix BigInt and other types, use explicit conversions');
}

export function LT(x: any, y: any): boolean {
	return __compare(x, y, 0);
}
export function LE(x: any, y: any): boolean {
	return __compare(x, y, 1);
}
export function GT(x: any, y: any): boolean {
	return __compare(x, y, 2);
}
export function GE(x: any, y: any): boolean {
	return __compare(x, y, 3);
}

export function EQ(x: any, y: any): boolean {
	while(true) {
		if(__isBigInt(x)) {
			if(__isBigInt(y)) return equal(x, y);
			return EQ(y, x);
		} else if(typeof x === 'number') {
			if(__isBigInt(y)) return __equalToNumber(y, x);
			if(typeof y !== 'object') return x == y;
			y = __toPrimitive(y);
		} else if(typeof x === 'string') {
			if(__isBigInt(y)) {
				x = __fromString(x);
				if(x === null) return false;
				return equal(x, y);
			}
			if(typeof y !== 'object') return x == y;
			y = __toPrimitive(y);
		} else if(typeof x === 'boolean') {
			if(__isBigInt(y)) return __equalToNumber(y, +x);
			if(typeof y !== 'object') return x == y;
			y = __toPrimitive(y);
		} else if(typeof x === 'symbol') {
			if(__isBigInt(y)) return false;
			if(typeof y !== 'object') return x == y;
			y = __toPrimitive(y);
		} else if(typeof x === 'object') {
			if(typeof y === 'object' && y.constructor !== JSBI) return x == y;
			x = __toPrimitive(x);
		} else {
			return x == y;
		}
	}
}

export function NE(x: any, y: any): boolean {
	return !EQ(x, y);
}

// DataView-related functionality.

export function DataViewGetBigInt64(
	dataview: DataView, byteOffset: number, littleEndian: boolean = false) {
	return asIntN(
		64, DataViewGetBigUint64(dataview, byteOffset, littleEndian));
}

export function DataViewGetBigUint64(
	dataview: DataView, byteOffset: number, littleEndian: boolean = false) {
	const [h, l] = littleEndian ? [4, 0] : [0, 4];
	const high = dataview.getUint32(byteOffset + h, littleEndian);
	const low = dataview.getUint32(byteOffset + l, littleEndian);
	const result = new JSBI(3, false);
	result.__setDigit(0, low & 0x3FFFFFFF);
	result.__setDigit(1, ((high & 0xFFFFFFF) << 2) | (low >>> 30));
	result.__setDigit(2, high >>> 28);
	return __trim(result);
}

export function DataViewSetBigInt64(
	dataview: DataView, byteOffset: number, value: JSBI,
	littleEndian: boolean = false) {
	DataViewSetBigUint64(dataview, byteOffset, value, littleEndian);
}

export function DataViewSetBigUint64(
	dataview: DataView, byteOffset: number, value: JSBI,
	littleEndian: boolean = false) {
	value = asUintN(64, value);
	let high = 0;
	let low = 0;
	if(value.length > 0) {
		low = value.__digit(0);
		if(value.length > 1) {
			const d1 = value.__digit(1);
			low = low | d1 << 30;
			high = d1 >>> 2;
			if(value.length > 2) {
				high = high | (value.__digit(2) << 28);
			}
		}
	}
	const [h, l] = littleEndian ? [4, 0] : [0, 4];
	dataview.setUint32(byteOffset + h, high, littleEndian);
	dataview.setUint32(byteOffset + l, low, littleEndian);
}

// Helpers.

function __zero(): JSBI {
	return new JSBI(0, false);
}

function __oneDigit(value: number, sign: boolean): JSBI {
	const result = new JSBI(1, sign);
	result.__setDigit(0, value);
	return result;
}


function __copy(jsbi: JSBI): JSBI {
	const result = new JSBI(jsbi.length, jsbi.sign);
	for(let i = 0; i < jsbi.length; i++) {
		result[i] = jsbi[i];
	}
	return result;
}

function __trim(jsbi: JSBI): JSBI {
	let newLength = jsbi.length;
	let last = jsbi[newLength - 1];
	while(last === 0) {
		newLength--;
		last = jsbi[newLength - 1];
		jsbi.pop();
	}
	if(newLength === 0) jsbi.sign = false;
	return jsbi;
}

function __initializeDigits(jsbi: JSBI): void {
	for(let i = 0; i < jsbi.length; i++) {
		jsbi[i] = 0;
	}
}

function __decideRounding(x: JSBI, mantissaBitsUnset: number,
	digitIndex: number, currentDigit: number): 1 | 0 | -1 {
	if(mantissaBitsUnset > 0) return -1;
	let topUnconsumedBit;
	if(mantissaBitsUnset < 0) {
		topUnconsumedBit = -mantissaBitsUnset - 1;
	} else {
		// {currentDigit} fit the mantissa exactly; look at the next digit.
		if(digitIndex === 0) return -1;
		digitIndex--;
		currentDigit = x.__digit(digitIndex);
		topUnconsumedBit = 29;
	}
	// If the most significant remaining bit is 0, round down.
	let mask = 1 << topUnconsumedBit;
	if((currentDigit & mask) === 0) return -1;
	// If any other remaining bit is set, round up.
	mask -= 1;
	if((currentDigit & mask) !== 0) return 1;
	while(digitIndex > 0) {
		digitIndex--;
		if(x.__digit(digitIndex) !== 0) return 1;
	}
	return 0;
}

function __fromDouble(value: number): JSBI {
	const sign = value < 0;
	__kBitConversionDouble[0] = value;
	const rawExponent =
		(__kBitConversionInts[__kBitConversionIntHigh] >>> 20) &
		0x7FF;
	const exponent = rawExponent - 0x3FF;
	const digits = ((exponent / 30) | 0) + 1;
	const result = new JSBI(digits, sign);
	const kHiddenBit = 0x00100000;
	let mantissaHigh =
		(__kBitConversionInts[__kBitConversionIntHigh] & 0xFFFFF) |
		kHiddenBit;
	let mantissaLow = __kBitConversionInts[__kBitConversionIntLow];
	const kMantissaHighTopBit = 20;
	// 0-indexed position of most significant bit in most significant digit.
	const msdTopBit = exponent % 30;
	// Number of unused bits in the mantissa. We'll keep them shifted to the
	// left (i.e. most significant part).
	let remainingMantissaBits = 0;
	// Next digit under construction.
	let digit;
	// First, build the MSD by shifting the mantissa appropriately.
	if(msdTopBit < kMantissaHighTopBit) {
		const shift = kMantissaHighTopBit - msdTopBit;
		remainingMantissaBits = shift + 32;
		digit = mantissaHigh >>> shift;
		mantissaHigh = (mantissaHigh << (32 - shift)) | (mantissaLow >>> shift);
		mantissaLow = mantissaLow << (32 - shift);
	} else if(msdTopBit === kMantissaHighTopBit) {
		remainingMantissaBits = 32;
		digit = mantissaHigh;
		mantissaHigh = mantissaLow;
		mantissaLow = 0;
	} else {
		const shift = msdTopBit - kMantissaHighTopBit;
		remainingMantissaBits = 32 - shift;
		digit = (mantissaHigh << shift) | (mantissaLow >>> (32 - shift));
		mantissaHigh = mantissaLow << shift;
		mantissaLow = 0;
	}
	result.__setDigit(digits - 1, digit);
	// Then fill in the rest of the digits.
	for(let digitIndex = digits - 2; digitIndex >= 0; digitIndex--) {
		if(remainingMantissaBits > 0) {
			remainingMantissaBits -= 30;
			digit = mantissaHigh >>> 2;
			mantissaHigh = (mantissaHigh << 30) | (mantissaLow >>> 2);
			mantissaLow = (mantissaLow << 30);
		} else {
			digit = 0;
		}
		result.__setDigit(digitIndex, digit);
	}
	return __trim(result);
}

function __isWhitespace(c: number): boolean {
	if(c <= 0x0D && c >= 0x09) return true;
	if(c <= 0x9F) return c === 0x20;
	if(c <= 0x01FFFF) {
		return c === 0xA0 || c === 0x1680;
	}
	if(c <= 0x02FFFF) {
		c &= 0x01FFFF;
		return c <= 0x0A || c === 0x28 || c === 0x29 || c === 0x2F ||
			c === 0x5F || c === 0x1000;
	}
	return c === 0xFEFF;
}

function __fromString(string: string, radix: number = 0): JSBI | null {
	let sign = 0;
	let leadingZero = false;
	const length = string.length;
	let cursor = 0;
	if(cursor === length) return __zero();
	let current = string.charCodeAt(cursor);
	// Skip whitespace.
	while(__isWhitespace(current)) {
		if(++cursor === length) return __zero();
		current = string.charCodeAt(cursor);
	}

	// Detect radix.
	if(current === 0x2B) { // '+'
		if(++cursor === length) return null;
		current = string.charCodeAt(cursor);
		sign = 1;
	} else if(current === 0x2D) { // '-'
		if(++cursor === length) return null;
		current = string.charCodeAt(cursor);
		sign = -1;
	}

	if(radix === 0) {
		radix = 10;
		if(current === 0x30) { // '0'
			if(++cursor === length) return __zero();
			current = string.charCodeAt(cursor);
			if(current === 0x58 || current === 0x78) { // 'X' or 'x'
				radix = 16;
				if(++cursor === length) return null;
				current = string.charCodeAt(cursor);
			} else if(current === 0x4F || current === 0x6F) { // 'O' or 'o'
				radix = 8;
				if(++cursor === length) return null;
				current = string.charCodeAt(cursor);
			} else if(current === 0x42 || current === 0x62) { // 'B' or 'b'
				radix = 2;
				if(++cursor === length) return null;
				current = string.charCodeAt(cursor);
			} else {
				leadingZero = true;
			}
		}
	} else if(radix === 16) {
		if(current === 0x30) { // '0'
			// Allow "0x" prefix.
			if(++cursor === length) return __zero();
			current = string.charCodeAt(cursor);
			if(current === 0x58 || current === 0x78) { // 'X' or 'x'
				if(++cursor === length) return null;
				current = string.charCodeAt(cursor);
			} else {
				leadingZero = true;
			}
		}
	}
	if(sign !== 0 && radix !== 10) return null;
	// Skip leading zeros.
	while(current === 0x30) {
		leadingZero = true;
		if(++cursor === length) return __zero();
		current = string.charCodeAt(cursor);
	}

	// Allocate result.
	const chars = length - cursor;
	let bitsPerChar = __kMaxBitsPerChar[radix];
	let roundup = __kBitsPerCharTableMultiplier - 1;
	if(chars > (1 << 30) / bitsPerChar) return null;
	const bitsMin =
		(bitsPerChar * chars + roundup) >>> __kBitsPerCharTableShift;
	const resultLength = ((bitsMin + 29) / 30) | 0;
	const result = new JSBI(resultLength, false);

	// Parse.
	const limDigit = radix < 10 ? radix : 10;
	const limAlpha = radix > 10 ? radix - 10 : 0;

	if((radix & (radix - 1)) === 0) {
		// Power-of-two radix.
		bitsPerChar >>= __kBitsPerCharTableShift;
		const parts = [];
		const partsBits = [];
		let done = false;
		do {
			let part = 0;
			let bits = 0;
			while(true) {
				let d;
				if(((current - 48) >>> 0) < limDigit) {
					d = current - 48;
				} else if((((current | 32) - 97) >>> 0) < limAlpha) {
					d = (current | 32) - 87;
				} else {
					done = true;
					break;
				}
				bits += bitsPerChar;
				part = (part << bitsPerChar) | d;
				if(++cursor === length) {
					done = true;
					break;
				}
				current = string.charCodeAt(cursor);
				if(bits + bitsPerChar > 30) break;
			}
			parts.push(part);
			partsBits.push(bits);
		} while(!done);
		__fillFromParts(result, parts, partsBits);
	} else {
		__initializeDigits(result);
		let done = false;
		let charsSoFar = 0;
		do {
			let part = 0;
			let multiplier = 1;
			while(true) {
				let d;
				if(((current - 48) >>> 0) < limDigit) {
					d = current - 48;
				} else if((((current | 32) - 97) >>> 0) < limAlpha) {
					d = (current | 32) - 87;
				} else {
					done = true;
					break;
				}

				const m = multiplier * radix;
				if(m > 0x3FFFFFFF) break;
				multiplier = m;
				part = part * radix + d;
				charsSoFar++;
				if(++cursor === length) {
					done = true;
					break;
				}
				current = string.charCodeAt(cursor);
			}
			roundup = __kBitsPerCharTableMultiplier * 30 - 1;
			const digitsSoFar = (((bitsPerChar * charsSoFar + roundup) >>>
				__kBitsPerCharTableShift) / 30) | 0;
			__inplaceMultiplyAdd(result, multiplier, part, digitsSoFar);
		} while(!done);
	}

	if(cursor !== length) {
		if(!__isWhitespace(current)) return null;
		for(cursor++; cursor < length; cursor++) {
			current = string.charCodeAt(cursor);
			if(!__isWhitespace(current)) return null;
		}
	}

	// Get result.
	result.sign = (sign === -1);
	return __trim(result);
}

function __fillFromParts(result: JSBI, parts: number[], partsBits: number[]): void {
	let digitIndex = 0;
	let digit = 0;
	let bitsInDigit = 0;
	for(let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		const partBits = partsBits[i];
		digit |= (part << bitsInDigit);
		bitsInDigit += partBits;
		if(bitsInDigit === 30) {
			result.__setDigit(digitIndex++, digit);
			bitsInDigit = 0;
			digit = 0;
		} else if(bitsInDigit > 30) {
			result.__setDigit(digitIndex++, digit & 0x3FFFFFFF);
			bitsInDigit -= 30;
			digit = part >>> (partBits - bitsInDigit);
		}
	}
	if(digit !== 0) {
		if(digitIndex >= result.length) throw new Error('implementation bug');
		result.__setDigit(digitIndex++, digit);
	}
	for(; digitIndex < result.length; digitIndex++) {
		result.__setDigit(digitIndex, 0);
	}
}

function __toStringBasePowerOfTwo(x: JSBI, radix: number): string {
	const length = x.length;
	let bits = radix - 1;
	bits = ((bits >>> 1) & 0x55) + (bits & 0x55);
	bits = ((bits >>> 2) & 0x33) + (bits & 0x33);
	bits = ((bits >>> 4) & 0x0F) + (bits & 0x0F);
	const bitsPerChar = bits;
	const charMask = radix - 1;
	const msd = x.__digit(length - 1);
	const msdLeadingZeros = __clz30(msd);
	const bitLength = length * 30 - msdLeadingZeros;
	let charsRequired =
		((bitLength + bitsPerChar - 1) / bitsPerChar) | 0;
	if(x.sign) charsRequired++;
	if(charsRequired > (1 << 28)) throw new Error('string too long');
	const result = new Array(charsRequired);
	let pos = charsRequired - 1;
	let digit = 0;
	let availableBits = 0;
	for(let i = 0; i < length - 1; i++) {
		const newDigit = x.__digit(i);
		const current = (digit | (newDigit << availableBits)) & charMask;
		result[pos--] = __kConversionChars[current];
		const consumedBits = bitsPerChar - availableBits;
		digit = newDigit >>> consumedBits;
		availableBits = 30 - consumedBits;
		while(availableBits >= bitsPerChar) {
			result[pos--] = __kConversionChars[digit & charMask];
			digit >>>= bitsPerChar;
			availableBits -= bitsPerChar;
		}
	}
	const current = (digit | (msd << availableBits)) & charMask;
	result[pos--] = __kConversionChars[current];
	digit = msd >>> (bitsPerChar - availableBits);
	while(digit !== 0) {
		result[pos--] = __kConversionChars[digit & charMask];
		digit >>>= bitsPerChar;
	}
	if(x.sign) result[pos--] = '-';
	if(pos !== -1) throw new Error('implementation bug');
	return result.join('');
}

function __toStringGeneric(x: JSBI, radix: number, isRecursiveCall: boolean): string {
	const length = x.length;
	if(length === 0) return '';
	if(length === 1) {
		let result = x.__unsignedDigit(0).toString(radix);
		if(isRecursiveCall === false && x.sign) {
			result = '-' + result;
		}
		return result;
	}
	const bitLength = length * 30 - __clz30(x.__digit(length - 1));
	const maxBitsPerChar = __kMaxBitsPerChar[radix];
	const minBitsPerChar = maxBitsPerChar - 1;
	let charsRequired = bitLength * __kBitsPerCharTableMultiplier;
	charsRequired += minBitsPerChar - 1;
	charsRequired = (charsRequired / minBitsPerChar) | 0;
	const secondHalfChars = (charsRequired + 1) >> 1;
	// Divide-and-conquer: split by a power of {radix} that's approximately
	// the square root of {x}, then recurse.
	const conqueror = exponentiate(__oneDigit(radix, false),
		__oneDigit(secondHalfChars, false));
	let quotient;
	let secondHalf;
	const divisor = conqueror.__unsignedDigit(0);
	if(conqueror.length === 1 && divisor <= 0x7FFF) {
		quotient = new JSBI(x.length, false);
		__initializeDigits(quotient);
		let remainder = 0;
		for(let i = x.length * 2 - 1; i >= 0; i--) {
			const input = (remainder << 15) | x.__halfDigit(i);
			quotient.__setHalfDigit(i, (input / divisor) | 0);
			remainder = (input % divisor) | 0;
		}
		secondHalf = remainder.toString(radix);
	} else {
		const divisionResult = __absoluteDivLarge(x, conqueror, true, true);
		quotient = divisionResult.quotient;
		const remainder = __trim(divisionResult.remainder);
		secondHalf = __toStringGeneric(remainder, radix, true);
	}
	__trim(quotient);
	let firstHalf = __toStringGeneric(quotient, radix, true);
	while(secondHalf.length < secondHalfChars) {
		secondHalf = '0' + secondHalf;
	}
	if(isRecursiveCall === false && x.sign) {
		firstHalf = '-' + firstHalf;
	}
	return firstHalf + secondHalf;
}

function __unequalSign(leftNegative: boolean): number {
	return leftNegative ? -1 : 1;
}
function __absoluteGreater(bothNegative: boolean): number {
	return bothNegative ? -1 : 1;
}
function __absoluteLess(bothNegative: boolean): number {
	return bothNegative ? 1 : -1;
}

function __compareToBigInt(x: JSBI, y: JSBI): number {
	const xSign = x.sign;
	if(xSign !== y.sign) return __unequalSign(xSign);
	const result = __absoluteCompare(x, y);
	if(result > 0) return __absoluteGreater(xSign);
	if(result < 0) return __absoluteLess(xSign);
	return 0;
}

function __compareToNumber(x: JSBI, y: number): number {
	if(__isOneDigitInt(y)) {
		const xSign = x.sign;
		const ySign = (y < 0);
		if(xSign !== ySign) return __unequalSign(xSign);
		if(x.length === 0) {
			if(ySign) throw new Error('implementation bug');
			return y === 0 ? 0 : -1;
		}
		// Any multi-digit BigInt is bigger than an int32.
		if(x.length > 1) return __absoluteGreater(xSign);
		const yAbs = Math.abs(y);
		const xDigit = x.__unsignedDigit(0);
		if(xDigit > yAbs) return __absoluteGreater(xSign);
		if(xDigit < yAbs) return __absoluteLess(xSign);
		return 0;
	}
	return __compareToDouble(x, y);
}

function __compareToDouble(x: JSBI, y: number): number {
	if(y !== y) return y; // NaN.
	if(y === Infinity) return -1;
	if(y === -Infinity) return 1;
	const xSign = x.sign;
	const ySign = (y < 0);
	if(xSign !== ySign) return __unequalSign(xSign);
	if(y === 0) {
		throw new Error('implementation bug: should be handled elsewhere');
	}
	if(x.length === 0) return -1;
	__kBitConversionDouble[0] = y;
	const rawExponent =
		(__kBitConversionInts[__kBitConversionIntHigh] >>> 20) &
		0x7FF;
	if(rawExponent === 0x7FF) {
		throw new Error('implementation bug: handled elsewhere');
	}
	const exponent = rawExponent - 0x3FF;
	if(exponent < 0) {
		// The absolute value of y is less than 1. Only 0n has an absolute
		// value smaller than that, but we've already covered that case.
		return __absoluteGreater(xSign);
	}
	const xLength = x.length;
	let xMsd = x.__digit(xLength - 1);
	const msdLeadingZeros = __clz30(xMsd);
	const xBitLength = xLength * 30 - msdLeadingZeros;
	const yBitLength = exponent + 1;
	if(xBitLength < yBitLength) return __absoluteLess(xSign);
	if(xBitLength > yBitLength) return __absoluteGreater(xSign);
	// Same sign, same bit length. Shift mantissa to align with x and compare
	// bit for bit.
	const kHiddenBit = 0x00100000;
	let mantissaHigh =
		(__kBitConversionInts[__kBitConversionIntHigh] & 0xFFFFF) |
		kHiddenBit;
	let mantissaLow = __kBitConversionInts[__kBitConversionIntLow];
	const kMantissaHighTopBit = 20;
	const msdTopBit = 29 - msdLeadingZeros;
	if(msdTopBit !== (((xBitLength - 1) % 30) | 0)) {
		throw new Error('implementation bug');
	}
	let compareMantissa; // Shifted chunk of mantissa.
	let remainingMantissaBits = 0;
	// First, compare most significant digit against beginning of mantissa.
	if(msdTopBit < kMantissaHighTopBit) {
		const shift = kMantissaHighTopBit - msdTopBit;
		remainingMantissaBits = shift + 32;
		compareMantissa = mantissaHigh >>> shift;
		mantissaHigh = (mantissaHigh << (32 - shift)) | (mantissaLow >>> shift);
		mantissaLow = mantissaLow << (32 - shift);
	} else if(msdTopBit === kMantissaHighTopBit) {
		remainingMantissaBits = 32;
		compareMantissa = mantissaHigh;
		mantissaHigh = mantissaLow;
		mantissaLow = 0;
	} else {
		const shift = msdTopBit - kMantissaHighTopBit;
		remainingMantissaBits = 32 - shift;
		compareMantissa =
			(mantissaHigh << shift) | (mantissaLow >>> (32 - shift));
		mantissaHigh = mantissaLow << shift;
		mantissaLow = 0;
	}
	xMsd = xMsd >>> 0;
	compareMantissa = compareMantissa >>> 0;
	if(xMsd > compareMantissa) return __absoluteGreater(xSign);
	if(xMsd < compareMantissa) return __absoluteLess(xSign);
	// Then, compare additional digits against remaining mantissa bits.
	for(let digitIndex = xLength - 2; digitIndex >= 0; digitIndex--) {
		if(remainingMantissaBits > 0) {
			remainingMantissaBits -= 30;
			compareMantissa = mantissaHigh >>> 2;
			mantissaHigh = (mantissaHigh << 30) | (mantissaLow >>> 2);
			mantissaLow = (mantissaLow << 30);
		} else {
			compareMantissa = 0;
		}
		const digit = x.__unsignedDigit(digitIndex);
		if(digit > compareMantissa) return __absoluteGreater(xSign);
		if(digit < compareMantissa) return __absoluteLess(xSign);
	}
	// Integer parts are equal; check whether {y} has a fractional part.
	if(mantissaHigh !== 0 || mantissaLow !== 0) {
		if(remainingMantissaBits === 0) throw new Error('implementation bug');
		return __absoluteLess(xSign);
	}
	return 0;
}

function __equalToNumber(x: JSBI, y: number) {
	if(__isOneDigitInt(y)) {
		if(y === 0) return x.length === 0;
		// Any multi-digit BigInt is bigger than an int32.
		return (x.length === 1) && (x.sign === (y < 0)) &&
			(x.__unsignedDigit(0) === Math.abs(y));
	}
	return __compareToDouble(x, y) === 0;
}

// Comparison operations, chosen such that "op ^ 2" reverses direction:
// 0 - lessThan
// 1 - lessThanOrEqual
// 2 - greaterThan
// 3 - greaterThanOrEqual
function __comparisonResultToBool(result: number, op: 0 | 1 | 2 | 3) {
	switch(op) {
		case 0: return result < 0;
		case 1: return result <= 0;
		case 2: return result > 0;
		case 3: return result >= 0;
	}
}

function __compare(x: any, y: any, op: 0 | 1 | 2 | 3): boolean {
	x = __toPrimitive(x);
	y = __toPrimitive(y);
	if(typeof x === 'string' && typeof y === 'string') {
		switch(op) {
			case 0: return x < y;
			case 1: return x <= y;
			case 2: return x > y;
			case 3: return x >= y;
		}
	}
	if(__isBigInt(x) && typeof y === 'string') {
		y = __fromString(y);
		if(y === null) return false;
		return __comparisonResultToBool(__compareToBigInt(x, y), op);
	}
	if(typeof x === 'string' && __isBigInt(y)) {
		x = __fromString(x);
		if(x === null) return false;
		return __comparisonResultToBool(__compareToBigInt(x, y), op);
	}
	x = __toNumeric(x);
	y = __toNumeric(y);
	if(__isBigInt(x)) {
		if(__isBigInt(y)) {
			return __comparisonResultToBool(__compareToBigInt(x, y), op);
		}
		if(typeof y !== 'number') throw new Error('implementation bug');
		return __comparisonResultToBool(__compareToNumber(x, y), op);
	}
	if(typeof x !== 'number') throw new Error('implementation bug');
	if(__isBigInt(y)) {
		// Note that "op ^ 2" reverses the op's direction.
		return __comparisonResultToBool(__compareToNumber(y, x),
			(op ^ 2) as 0 | 1 | 2 | 3);
	}
	if(typeof y !== 'number') throw new Error('implementation bug');
	switch(op) {
		case 0: return x < y;
		case 1: return x <= y;
		case 2: return x > y;
		case 3: return x >= y;
	}
}
function __clzmsd(jsbi: JSBI): number {
	return __clz30(jsbi.__digit(jsbi.length - 1));
}

function __absoluteAdd(x: JSBI, y: JSBI, resultSign: boolean): JSBI {
	if(x.length < y.length) return __absoluteAdd(y, x, resultSign);
	if(x.length === 0) return x;
	if(y.length === 0) return x.sign === resultSign ? x : unaryMinus(x);
	let resultLength = x.length;
	if(__clzmsd(x) === 0 || (y.length === x.length && __clzmsd(y) === 0)) {
		resultLength++;
	}
	const result = new JSBI(resultLength, resultSign);
	let carry = 0;
	let i = 0;
	for(; i < y.length; i++) {
		const r = x.__digit(i) + y.__digit(i) + carry;
		carry = r >>> 30;
		result.__setDigit(i, r & 0x3FFFFFFF);
	}
	for(; i < x.length; i++) {
		const r = x.__digit(i) + carry;
		carry = r >>> 30;
		result.__setDigit(i, r & 0x3FFFFFFF);
	}
	if(i < result.length) {
		result.__setDigit(i, carry);
	}
	return __trim(result);
}

function __absoluteSub(x: JSBI, y: JSBI, resultSign: boolean): JSBI {
	if(x.length === 0) return x;
	if(y.length === 0) return x.sign === resultSign ? x : unaryMinus(x);
	const result = new JSBI(x.length, resultSign);
	let borrow = 0;
	let i = 0;
	for(; i < y.length; i++) {
		const r = x.__digit(i) - y.__digit(i) - borrow;
		borrow = (r >>> 30) & 1;
		result.__setDigit(i, r & 0x3FFFFFFF);
	}
	for(; i < x.length; i++) {
		const r = x.__digit(i) - borrow;
		borrow = (r >>> 30) & 1;
		result.__setDigit(i, r & 0x3FFFFFFF);
	}
	return __trim(result);
}

function __absoluteAddOne(x: JSBI, sign: boolean, result: JSBI | null = null) {
	const inputLength = x.length;
	if(result === null) {
		result = new JSBI(inputLength, sign);
	} else {
		result.sign = sign;
	}
	let carry = 1;
	for(let i = 0; i < inputLength; i++) {
		const r = x.__digit(i) + carry;
		carry = r >>> 30;
		result.__setDigit(i, r & 0x3FFFFFFF);
	}
	if(carry !== 0) {
		result.__setDigitGrow(inputLength, 1);
	}
	return result;
}

function __absoluteSubOne(x: JSBI, resultLength?: number) {
	const length = x.length;
	resultLength = resultLength || length;
	const result = new JSBI(resultLength, false);
	let borrow = 1;
	for(let i = 0; i < length; i++) {
		const r = x.__digit(i) - borrow;
		borrow = (r >>> 30) & 1;
		result.__setDigit(i, r & 0x3FFFFFFF);
	}
	if(borrow !== 0) throw new Error('implementation bug');
	for(let i = length; i < resultLength; i++) {
		result.__setDigit(i, 0);
	}
	return result;
}

function __absoluteAnd(x: JSBI, y: JSBI, result: JSBI | null = null) {
	let xLength = x.length;
	let yLength = y.length;
	let numPairs = yLength;
	if(xLength < yLength) {
		numPairs = xLength;
		const tmp = x;
		const tmpLength = xLength;
		x = y;
		xLength = yLength;
		y = tmp;
		yLength = tmpLength;
	}
	let resultLength = numPairs;
	if(result === null) {
		result = new JSBI(resultLength, false);
	} else {
		resultLength = result.length;
	}
	let i = 0;
	for(; i < numPairs; i++) {
		result.__setDigit(i, x.__digit(i) & y.__digit(i));
	}
	for(; i < resultLength; i++) {
		result.__setDigit(i, 0);
	}
	return result;
}

function __absoluteAndNot(x: JSBI, y: JSBI, result: JSBI | null = null) {
	const xLength = x.length;
	const yLength = y.length;
	let numPairs = yLength;
	if(xLength < yLength) {
		numPairs = xLength;
	}
	let resultLength = xLength;
	if(result === null) {
		result = new JSBI(resultLength, false);
	} else {
		resultLength = result.length;
	}
	let i = 0;
	for(; i < numPairs; i++) {
		result.__setDigit(i, x.__digit(i) & ~y.__digit(i));
	}
	for(; i < xLength; i++) {
		result.__setDigit(i, x.__digit(i));
	}
	for(; i < resultLength; i++) {
		result.__setDigit(i, 0);
	}
	return result;
}

function __absoluteOr(x: JSBI, y: JSBI, result: JSBI | null = null) {
	let xLength = x.length;
	let yLength = y.length;
	let numPairs = yLength;
	if(xLength < yLength) {
		numPairs = xLength;
		const tmp = x;
		const tmpLength = xLength;
		x = y;
		xLength = yLength;
		y = tmp;
		yLength = tmpLength;
	}
	let resultLength = xLength;
	if(result === null) {
		result = new JSBI(resultLength, false);
	} else {
		resultLength = result.length;
	}
	let i = 0;
	for(; i < numPairs; i++) {
		result.__setDigit(i, x.__digit(i) | y.__digit(i));
	}
	for(; i < xLength; i++) {
		result.__setDigit(i, x.__digit(i));
	}
	for(; i < resultLength; i++) {
		result.__setDigit(i, 0);
	}
	return result;
}

function __absoluteXor(x: JSBI, y: JSBI, result: JSBI | null = null) {
	let xLength = x.length;
	let yLength = y.length;
	let numPairs = yLength;
	if(xLength < yLength) {
		numPairs = xLength;
		const tmp = x;
		const tmpLength = xLength;
		x = y;
		xLength = yLength;
		y = tmp;
		yLength = tmpLength;
	}
	let resultLength = xLength;
	if(result === null) {
		result = new JSBI(resultLength, false);
	} else {
		resultLength = result.length;
	}
	let i = 0;
	for(; i < numPairs; i++) {
		result.__setDigit(i, x.__digit(i) ^ y.__digit(i));
	}
	for(; i < xLength; i++) {
		result.__setDigit(i, x.__digit(i));
	}
	for(; i < resultLength; i++) {
		result.__setDigit(i, 0);
	}
	return result;
}

function __absoluteCompare(x: JSBI, y: JSBI) {
	const diff = x.length - y.length;
	if(diff !== 0) return diff;
	let i = x.length - 1;
	while(i >= 0 && x.__digit(i) === y.__digit(i)) i--;
	if(i < 0) return 0;
	return x.__unsignedDigit(i) > y.__unsignedDigit(i) ? 1 : -1;
}

function __multiplyAccumulate(multiplicand: JSBI, multiplier: number,
	accumulator: JSBI, accumulatorIndex: number): void {
	if(multiplier === 0) return;
	const m2Low = multiplier & 0x7FFF;
	const m2High = multiplier >>> 15;
	let carry = 0;
	let high = 0;
	for(let i = 0; i < multiplicand.length; i++, accumulatorIndex++) {
		let acc = accumulator.__digit(accumulatorIndex);
		const m1 = multiplicand.__digit(i);
		const m1Low = m1 & 0x7FFF;
		const m1High = m1 >>> 15;
		const rLow = __imul(m1Low, m2Low);
		const rMid1 = __imul(m1Low, m2High);
		const rMid2 = __imul(m1High, m2Low);
		const rHigh = __imul(m1High, m2High);
		acc += high + rLow + carry;
		carry = acc >>> 30;
		acc &= 0x3FFFFFFF;
		acc += ((rMid1 & 0x7FFF) << 15) + ((rMid2 & 0x7FFF) << 15);
		carry += acc >>> 30;
		high = rHigh + (rMid1 >>> 15) + (rMid2 >>> 15);
		accumulator.__setDigit(accumulatorIndex, acc & 0x3FFFFFFF);
	}
	for(; carry !== 0 || high !== 0; accumulatorIndex++) {
		let acc = accumulator.__digit(accumulatorIndex);
		acc += carry + high;
		high = 0;
		carry = acc >>> 30;
		accumulator.__setDigit(accumulatorIndex, acc & 0x3FFFFFFF);
	}
}

function __internalMultiplyAdd(source: JSBI, factor: number, summand: number,
	n: number, result: JSBI): void {
	let carry = summand;
	let high = 0;
	for(let i = 0; i < n; i++) {
		const digit = source.__digit(i);
		const rx = __imul(digit & 0x7FFF, factor);
		const ry = __imul(digit >>> 15, factor);
		const r = rx + ((ry & 0x7FFF) << 15) + high + carry;
		carry = r >>> 30;
		high = ry >>> 15;
		result.__setDigit(i, r & 0x3FFFFFFF);
	}
	if(result.length > n) {
		result.__setDigit(n++, carry + high);
		while(n < result.length) {
			result.__setDigit(n++, 0);
		}
	} else {
		if(carry + high !== 0) throw new Error('implementation bug');
	}
}

function __inplaceMultiplyAdd(jsbi: JSBI, multiplier: number, summand: number, length: number): void {
	if(length > jsbi.length) length = jsbi.length;
	const mLow = multiplier & 0x7FFF;
	const mHigh = multiplier >>> 15;
	let carry = 0;
	let high = summand;
	for(let i = 0; i < length; i++) {
		const d = jsbi.__digit(i);
		const dLow = d & 0x7FFF;
		const dHigh = d >>> 15;
		const pLow = __imul(dLow, mLow);
		const pMid1 = __imul(dLow, mHigh);
		const pMid2 = __imul(dHigh, mLow);
		const pHigh = __imul(dHigh, mHigh);
		let result = high + pLow + carry;
		carry = result >>> 30;
		result &= 0x3FFFFFFF;
		result += ((pMid1 & 0x7FFF) << 15) + ((pMid2 & 0x7FFF) << 15);
		carry += result >>> 30;
		high = pHigh + (pMid1 >>> 15) + (pMid2 >>> 15);
		jsbi.__setDigit(i, result & 0x3FFFFFFF);
	}
	if(carry !== 0 || high !== 0) {
		throw new Error('implementation bug');
	}
}


function __absoluteDivSmall(x: JSBI, divisor: number,
	quotient: JSBI | null = null): JSBI {
	if(quotient === null) quotient = new JSBI(x.length, false);
	let remainder = 0;
	for(let i = x.length * 2 - 1; i >= 0; i -= 2) {
		let input = ((remainder << 15) | x.__halfDigit(i)) >>> 0;
		const upperHalf = (input / divisor) | 0;
		remainder = (input % divisor) | 0;
		input = ((remainder << 15) | x.__halfDigit(i - 1)) >>> 0;
		const lowerHalf = (input / divisor) | 0;
		remainder = (input % divisor) | 0;
		quotient.__setDigit(i >>> 1, (upperHalf << 15) | lowerHalf);
	}
	return quotient;
}

function __absoluteModSmall(x: JSBI, divisor: number): number {
	let remainder = 0;
	for(let i = x.length * 2 - 1; i >= 0; i--) {
		const input = ((remainder << 15) | x.__halfDigit(i)) >>> 0;
		remainder = (input % divisor) | 0;
	}
	return remainder;
}

function __absoluteDivLarge(dividend: JSBI, divisor: JSBI, wantQuotient: false,
	wantRemainder: false): undefined;
function __absoluteDivLarge(dividend: JSBI, divisor: JSBI, wantQuotient: true,
	wantRemainder: true): { quotient: JSBI; remainder: JSBI; };
function __absoluteDivLarge(dividend: JSBI, divisor: JSBI,
	wantQuotient: boolean, wantRemainder: boolean): JSBI;
function __absoluteDivLarge(dividend: JSBI, divisor: JSBI,
	wantQuotient: boolean, wantRemainder: boolean): { quotient: JSBI; remainder: JSBI; } | JSBI | undefined {
	const n = divisor.__halfDigitLength();
	const n2 = divisor.length;
	const m = dividend.__halfDigitLength() - n;
	let q = null;
	if(wantQuotient) {
		q = new JSBI((m + 2) >>> 1, false);
		__initializeDigits(q);
	}
	const qhatv = new JSBI((n + 2) >>> 1, false);
	__initializeDigits(qhatv);
	// D1.
	const shift = __clz15(divisor.__halfDigit(n - 1));
	if(shift > 0) {
		divisor = __specialLeftShift(divisor, shift, 0 /* add no digits*/);
	}
	const u = __specialLeftShift(dividend, shift, 1 /* add one digit */);
	// D2.
	const vn1 = divisor.__halfDigit(n - 1);
	let halfDigitBuffer = 0;
	for(let j = m; j >= 0; j--) {
		// D3.
		let qhat = 0x7FFF;
		const ujn = u.__halfDigit(j + n);
		if(ujn !== vn1) {
			const input = ((ujn << 15) | u.__halfDigit(j + n - 1)) >>> 0;
			qhat = (input / vn1) | 0;
			let rhat = (input % vn1) | 0;
			const vn2 = divisor.__halfDigit(n - 2);
			const ujn2 = u.__halfDigit(j + n - 2);
			while((__imul(qhat, vn2) >>> 0) > (((rhat << 16) | ujn2) >>> 0)) {
				qhat--;
				rhat += vn1;
				if(rhat > 0x7FFF) break;
			}
		}
		// D4.
		__internalMultiplyAdd(divisor, qhat, 0, n2, qhatv);
		let c = __inplaceSub(u, qhatv, j, n + 1);
		if(c !== 0) {
			c = __inplaceAdd(u, divisor, j, n);
			u.__setHalfDigit(j + n, (u.__halfDigit(j + n) + c) & 0x7FFF);
			qhat--;
		}
		if(wantQuotient) {
			if(j & 1) {
				halfDigitBuffer = qhat << 15;
			} else {
				// TODO make this statically determinable
				(q as JSBI).__setDigit(j >>> 1, halfDigitBuffer | qhat);
			}
		}
	}
	if(wantRemainder) {
		__inplaceRightShift(u, shift);
		if(wantQuotient) {
			return { quotient: (q as JSBI), remainder: u };
		}
		return u;
	}
	if(wantQuotient) return (q as JSBI);
	// TODO find a way to make this statically unreachable?
	throw new Error('unreachable');
}

function __clz15(value: number): number {
	return __clz30(value) - 15;
}


// TODO: work on full digits, like __inplaceSub?
function __inplaceAdd(jsbi: JSBI, summand: JSBI, startIndex: number, halfDigits: number): number {
	let carry = 0;
	for(let i = 0; i < halfDigits; i++) {
		const sum = jsbi.__halfDigit(startIndex + i) +
			summand.__halfDigit(i) +
			carry;
		carry = sum >>> 15;
		jsbi.__setHalfDigit(startIndex + i, sum & 0x7FFF);
	}
	return carry;
}


function __inplaceSub(jsbi: JSBI, subtrahend: JSBI, startIndex: number, halfDigits: number):
	number {
	const fullSteps = (halfDigits - 1) >>> 1;
	let borrow = 0;
	if(startIndex & 1) {
		// this:   [..][..][..]
		// subtr.:   [..][..]
		startIndex >>= 1;
		let current = jsbi.__digit(startIndex);
		let r0 = current & 0x7FFF;
		let i = 0;
		for(; i < fullSteps; i++) {
			const sub = subtrahend.__digit(i);
			const r15 = (current >>> 15) - (sub & 0x7FFF) - borrow;
			borrow = (r15 >>> 15) & 1;
			jsbi.__setDigit(startIndex + i, ((r15 & 0x7FFF) << 15) | (r0 & 0x7FFF));
			current = jsbi.__digit(startIndex + i + 1);
			r0 = (current & 0x7FFF) - (sub >>> 15) - borrow;
			borrow = (r0 >>> 15) & 1;
		}
		// Unrolling the last iteration gives a 5% performance benefit!
		const sub = subtrahend.__digit(i);
		const r15 = (current >>> 15) - (sub & 0x7FFF) - borrow;
		borrow = (r15 >>> 15) & 1;
		jsbi.__setDigit(startIndex + i, ((r15 & 0x7FFF) << 15) | (r0 & 0x7FFF));
		const subTop = sub >>> 15;
		if(startIndex + i + 1 >= jsbi.length) {
			throw new RangeError('out of bounds');
		}
		if((halfDigits & 1) === 0) {
			current = jsbi.__digit(startIndex + i + 1);
			r0 = (current & 0x7FFF) - subTop - borrow;
			borrow = (r0 >>> 15) & 1;
			jsbi.__setDigit(startIndex + subtrahend.length,
				(current & 0x3FFF8000) | (r0 & 0x7FFF));
		}
	} else {
		startIndex >>= 1;
		let i = 0;
		for(; i < subtrahend.length - 1; i++) {
			const current = jsbi.__digit(startIndex + i);
			const sub = subtrahend.__digit(i);
			const r0 = (current & 0x7FFF) - (sub & 0x7FFF) - borrow;
			borrow = (r0 >>> 15) & 1;
			const r15 = (current >>> 15) - (sub >>> 15) - borrow;
			borrow = (r15 >>> 15) & 1;
			jsbi.__setDigit(startIndex + i, ((r15 & 0x7FFF) << 15) | (r0 & 0x7FFF));
		}
		const current = jsbi.__digit(startIndex + i);
		const sub = subtrahend.__digit(i);
		const r0 = (current & 0x7FFF) - (sub & 0x7FFF) - borrow;
		borrow = (r0 >>> 15) & 1;
		let r15 = 0;
		if((halfDigits & 1) === 0) {
			r15 = (current >>> 15) - (sub >>> 15) - borrow;
			borrow = (r15 >>> 15) & 1;
		}
		jsbi.__setDigit(startIndex + i, ((r15 & 0x7FFF) << 15) | (r0 & 0x7FFF));
	}
	return borrow;
}

function __inplaceRightShift(jsbi: JSBI, shift: number): void {
	if(shift === 0) return;
	let carry = jsbi.__digit(0) >>> shift;
	const last = jsbi.length - 1;
	for(let i = 0; i < last; i++) {
		const d = jsbi.__digit(i + 1);
		jsbi.__setDigit(i, ((d << (30 - shift)) & 0x3FFFFFFF) | carry);
		carry = d >>> shift;
	}
	jsbi.__setDigit(last, carry);
}


function __specialLeftShift(x: JSBI, shift: number, addDigit: 0 | 1): JSBI {
	const n = x.length;
	const resultLength = n + addDigit;
	const result = new JSBI(resultLength, false);
	if(shift === 0) {
		for(let i = 0; i < n; i++) result.__setDigit(i, x.__digit(i));
		if(addDigit > 0) result.__setDigit(n, 0);
		return result;
	}
	let carry = 0;
	for(let i = 0; i < n; i++) {
		const d = x.__digit(i);
		result.__setDigit(i, ((d << shift) & 0x3FFFFFFF) | carry);
		carry = d >>> (30 - shift);
	}
	if(addDigit > 0) {
		result.__setDigit(n, carry);
	}
	return result;
}

function __leftShiftByAbsolute(x: JSBI, y: JSBI): JSBI {
	const shift = __toShiftAmount(y);
	if(shift < 0) throw new RangeError('BigInt too big');
	const digitShift = (shift / 30) | 0;
	const bitsShift = shift % 30;
	const length = x.length;
	const grow = bitsShift !== 0 &&
		(x.__digit(length - 1) >>> (30 - bitsShift)) !== 0;
	const resultLength = length + digitShift + (grow ? 1 : 0);
	const result = new JSBI(resultLength, x.sign);
	if(bitsShift === 0) {
		let i = 0;
		for(; i < digitShift; i++) result.__setDigit(i, 0);
		for(; i < resultLength; i++) {
			result.__setDigit(i, x.__digit(i - digitShift));
		}
	} else {
		let carry = 0;
		for(let i = 0; i < digitShift; i++) result.__setDigit(i, 0);
		for(let i = 0; i < length; i++) {
			const d = x.__digit(i);
			result.__setDigit(
				i + digitShift, ((d << bitsShift) & 0x3FFFFFFF) | carry);
			carry = d >>> (30 - bitsShift);
		}
		if(grow) {
			result.__setDigit(length + digitShift, carry);
		} else {
			if(carry !== 0) throw new Error('implementation bug');
		}
	}
	return __trim(result);
}

function __rightShiftByAbsolute(x: JSBI, y: JSBI): JSBI {
	const length = x.length;
	const sign = x.sign;
	const shift = __toShiftAmount(y);
	if(shift < 0) return __rightShiftByMaximum(sign);
	const digitShift = (shift / 30) | 0;
	const bitsShift = shift % 30;
	let resultLength = length - digitShift;
	if(resultLength <= 0) return __rightShiftByMaximum(sign);
	// For negative numbers, round down if any bit was shifted out (so that
	// e.g. -5n >> 1n == -3n and not -2n). Check now whether this will happen
	// and whether itc an cause overflow into a new digit. If we allocate the
	// result large enough up front, it avoids having to do grow it later.
	let mustRoundDown = false;
	if(sign) {
		const mask = (1 << bitsShift) - 1;
		if((x.__digit(digitShift) & mask) !== 0) {
			mustRoundDown = true;
		} else {
			for(let i = 0; i < digitShift; i++) {
				if(x.__digit(i) !== 0) {
					mustRoundDown = true;
					break;
				}
			}
		}
	}
	// If bitsShift is non-zero, it frees up bits, preventing overflow.
	if(mustRoundDown && bitsShift === 0) {
		// Overflow cannot happen if the most significant digit has unset bits.
		const msd = x.__digit(length - 1);
		const roundingCanOverflow = ~msd === 0;
		if(roundingCanOverflow) resultLength++;
	}
	let result = new JSBI(resultLength, sign);
	if(bitsShift === 0) {
		// Zero out any overflow digit (see "roundingCanOverflow" above).
		result.__setDigit(resultLength - 1, 0);
		for(let i = digitShift; i < length; i++) {
			result.__setDigit(i - digitShift, x.__digit(i));
		}
	} else {
		let carry = x.__digit(digitShift) >>> bitsShift;
		const last = length - digitShift - 1;
		for(let i = 0; i < last; i++) {
			const d = x.__digit(i + digitShift + 1);
			result.__setDigit(i, ((d << (30 - bitsShift)) & 0x3FFFFFFF) | carry);
			carry = d >>> bitsShift;
		}
		result.__setDigit(last, carry);
	}
	if(mustRoundDown) {
		// Since the result is negative, rounding down means adding one to its
		// absolute value. This cannot overflow.
		result = __absoluteAddOne(result, true, result);
	}
	return __trim(result);
}

function __rightShiftByMaximum(sign: boolean): JSBI {
	if(sign) {
		return __oneDigit(1, true);
	}
	return __zero();
}

function __toShiftAmount(x: JSBI): number {
	if(x.length > 1) return -1;
	const value = x.__unsignedDigit(0);
	if(value > __kMaxLengthBits) return -1;
	return value;
}

function __toPrimitive(obj: any, hint = 'default'): any {
	if(typeof obj !== 'object') return obj;
	if(obj.constructor === JSBI) return obj;
	if(typeof Symbol !== 'undefined' &&
		typeof Symbol.toPrimitive === 'symbol') {
		if(obj[Symbol.toPrimitive]) {
			const primitive = obj[Symbol.toPrimitive](hint);
			if(typeof primitive !== 'object') return primitive;
			throw new TypeError('Cannot convert object to primitive value');
		}
	}
	const valueOf = obj.valueOf;
	if(valueOf) {
		const primitive = valueOf.call(obj);
		if(typeof primitive !== 'object') return primitive;
	}
	const toString = obj.toString;
	if(toString) {
		const primitive = toString.call(obj);
		if(typeof primitive !== 'object') return primitive;
	}
	throw new TypeError('Cannot convert object to primitive value');
}

function __toNumeric(value: unknown): number | JSBI {
	if(__isBigInt(value)) return value;
	return +(value as any);
}

function __isBigInt(value: unknown): value is JSBI {
	return typeof value === 'object' && value !== null &&
		value.constructor === JSBI;
}

function __truncateToNBits(n: number, x: JSBI): JSBI {
	const neededDigits = ((n + 29) / 30) | 0;
	const result = new JSBI(neededDigits, x.sign);
	const last = neededDigits - 1;
	for(let i = 0; i < last; i++) {
		result.__setDigit(i, x.__digit(i));
	}
	let msd = x.__digit(last);
	if((n % 30) !== 0) {
		const drop = 32 - (n % 30);
		msd = (msd << drop) >>> drop;
	}
	result.__setDigit(last, msd);
	return __trim(result);
}

function __truncateAndSubFromPowerOfTwo(n: number, x: JSBI,
	resultSign: boolean): JSBI {
	const neededDigits = ((n + 29) / 30) | 0;
	const result = new JSBI(neededDigits, resultSign);
	let i = 0;
	const last = neededDigits - 1;
	let borrow = 0;
	const limit = Math.min(last, x.length);
	for(; i < limit; i++) {
		const r = 0 - x.__digit(i) - borrow;
		borrow = (r >>> 30) & 1;
		result.__setDigit(i, r & 0x3FFFFFFF);
	}
	for(; i < last; i++) {
		result.__setDigit(i, (-borrow & 0x3FFFFFFF) | 0);
	}
	let msd = last < x.length ? x.__digit(last) : 0;
	const msdBitsConsumed = n % 30;
	let resultMsd;
	if(msdBitsConsumed === 0) {
		resultMsd = 0 - msd - borrow;
		resultMsd &= 0x3FFFFFFF;
	} else {
		const drop = 32 - msdBitsConsumed;
		msd = (msd << drop) >>> drop;
		const minuendMsd = 1 << (32 - drop);
		resultMsd = minuendMsd - msd - borrow;
		resultMsd &= (minuendMsd - 1);
	}
	result.__setDigit(last, resultMsd);
	return __trim(result);
}

function __digitPow(base: number, exponent: number) {
	let result = 1;
	while(exponent > 0) {
		if(exponent & 1) result *= base;
		exponent >>>= 1;
		base *= base;
	}
	return result;
}



var __kMaxLength = 1 << 25;
var __kMaxLengthBits = __kMaxLength << 5;
// Lookup table for the maximum number of bits required per character of a
// base-N string representation of a number. To increase accuracy, the array
// value is the actual value multiplied by 32. To generate this table:
//
// for (let i = 0; i <= 36; i++) {
//   console.log(Math.ceil(Math.log2(i) * 32) + ',');
// }
var __kMaxBitsPerChar = [
	0, 0, 32, 51, 64, 75, 83, 90, 96, // 0..8
	102, 107, 111, 115, 119, 122, 126, 128, // 9..16
	131, 134, 136, 139, 141, 143, 145, 147, // 17..24
	149, 151, 153, 154, 156, 158, 159, 160, // 25..32
	162, 163, 165, 166, // 33..36
];

var __kBitsPerCharTableShift = 5;
var __kBitsPerCharTableMultiplier = 1 << __kBitsPerCharTableShift;
var __kConversionChars = '0123456789abcdefghijklmnopqrstuvwxyz'.split('');
var __kBitConversionBuffer = new ArrayBuffer(8);
var __kBitConversionDouble = new Float64Array(__kBitConversionBuffer);
var __kBitConversionInts = new Int32Array(__kBitConversionBuffer);
function __detectBigEndian() {
	__kBitConversionDouble[0] = -0.0;
	return __kBitConversionInts[0] !== 0;
}
var __kBitConversionIntHigh = __detectBigEndian() ? 0 : 1;
var __kBitConversionIntLow = __detectBigEndian() ? 1 : 0;


// For IE11 compatibility.
// Note that the custom replacements are tailored for JSBI's needs, and as
// such are not reusable as general-purpose polyfills.
const __clz30 = function(x: number) {
	return Math.clz32(x) - 2;
};
const __imul = Math.imul;
function __isOneDigitInt(x: number) {
	return (x & 0x3FFFFFFF) === x;
}

// 默认导出对象，包含所有公共API
export default {
	BigInt,
	add,
	subtract,
	multiply,
	divide,
	remainder,
	exponentiate,
	unaryMinus,
	bitwiseNot,
	bitwiseAnd,
	bitwiseOr,
	bitwiseXor,
	leftShift,
	signedRightShift,
	lessThan,
	lessThanOrEqual,
	greaterThan,
	greaterThanOrEqual,
	equal,
	notEqual,
	asIntN,
	asUintN,
	DataViewGetBigInt64,
	DataViewGetBigUint64,
	DataViewSetBigInt64,
	DataViewSetBigUint64
};
