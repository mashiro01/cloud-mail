function unsupported() {
	throw new Error('unsupported_regex');
}

function clampRepeat(min, max, maxRepeat) {
	const limit = Number.isFinite(maxRepeat) ? Math.max(0, Math.floor(maxRepeat)) : 16;
	let boundedMin = Math.max(0, Math.floor(min));
	let boundedMax = Math.max(0, Math.floor(max));

	boundedMin = Math.min(boundedMin, limit);
	boundedMax = Math.min(boundedMax, limit);

	if (boundedMax < boundedMin) {
		boundedMin = boundedMax;
	}

	return { min: boundedMin, max: boundedMax };
}

function randomInt(rng, min, max) {
	if (max <= min) return min;
	const value = Number(rng());
	if (!Number.isFinite(value)) return min;
	const normalized = value < 0 ? 0 : value >= 1 ? Number.EPSILON : value;
	return min + Math.floor(normalized * (max - min + 1));
}

class Parser {
	constructor(input, maxRepeat) {
		this.input = input;
		this.pos = 0;
		this.maxRepeat = maxRepeat;
	}

	parse() {
		const node = this.parseAlternation();
		if (this.pos !== this.input.length) {
			unsupported();
		}
		if (node.type === 'seq' && node.nodes.length === 0) {
			unsupported();
		}
		return node;
	}

	parseAlternation() {
		const choices = [this.parseSequence()];
		while (this.peek() === '|') {
			this.pos += 1;
			choices.push(this.parseSequence());
		}

		if (choices.length === 1) {
			return choices[0];
		}
		return { type: 'alt', choices };
	}

	parseSequence() {
		const nodes = [];
		while (this.pos < this.input.length) {
			const ch = this.peek();
			if (ch === ')' || ch === '|') {
				break;
			}
			nodes.push(this.parseTerm());
		}
		return { type: 'seq', nodes };
	}

	parseTerm() {
		const atom = this.parseAtom();
		const quant = this.parseQuantifier();
		if (!quant) {
			return atom;
		}
		return { type: 'repeat', node: atom, min: quant.min, max: quant.max };
	}

	parseAtom() {
		const ch = this.peek();
		if (!ch) {
			unsupported();
		}

		if (ch === '(') {
			return this.parseGroup();
		}

		if (ch === '[') {
			return this.parseCharClass();
		}

		if (ch === '\\') {
			return this.parseEscapedLiteral();
		}

		if (ch === ')' || ch === ']' || ch === '{' || ch === '}' || ch === '?' || ch === '+' || ch === '*' || ch === '|') {
			unsupported();
		}

		this.pos += 1;
		return { type: 'lit', value: ch };
	}

	parseGroup() {
		this.expect('(');
		if (this.peek() === '?') {
			unsupported();
		}

		const node = this.parseAlternation();
		if (this.peek() !== ')') {
			unsupported();
		}
		this.expect(')');
		return node;
	}

	parseCharClass() {
		this.expect('[');
		if (this.peek() === '^') {
			unsupported();
		}

		const chars = [];
		let hasValue = false;

		while (this.pos < this.input.length && this.peek() !== ']') {
			const start = this.parseClassChar();
			hasValue = true;

			if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined) {
				this.pos += 1;
				const end = this.parseClassChar();
				if (start.codePointAt(0) > end.codePointAt(0)) {
					unsupported();
				}
				for (let code = start.codePointAt(0); code <= end.codePointAt(0); code += 1) {
					chars.push(String.fromCodePoint(code));
				}
			} else {
				chars.push(start);
			}
		}

		if (this.peek() !== ']' || !hasValue) {
			unsupported();
		}

		this.expect(']');
		return { type: 'class', chars: [...new Set(chars)] };
	}

	parseClassChar() {
		const ch = this.peek();
		if (!ch || ch === ']' || ch === '[') {
			unsupported();
		}

		if (ch === '\\') {
			this.pos += 1;
			const escaped = this.peek();
			if (!escaped) {
				unsupported();
			}
			this.pos += 1;
			return escaped;
		}

		this.pos += 1;
		return ch;
	}

	parseEscapedLiteral() {
		this.expect('\\');
		const ch = this.peek();
		if (!ch || /[0-9]/.test(ch)) {
			unsupported();
		}
		this.pos += 1;
		return { type: 'lit', value: ch };
	}

	parseQuantifier() {
		const ch = this.peek();
		if (ch === '?') {
			this.pos += 1;
			return clampRepeat(0, 1, this.maxRepeat);
		}
		if (ch === '+') {
			this.pos += 1;
			return clampRepeat(1, this.maxRepeat, this.maxRepeat);
		}
		if (ch === '*') {
			this.pos += 1;
			return clampRepeat(0, this.maxRepeat, this.maxRepeat);
		}
		if (ch !== '{') {
			return null;
		}

		this.pos += 1;
		const min = this.parseNumber();
		let max = min;

		if (this.peek() === ',') {
			this.pos += 1;
			max = this.parseNumber();
		}

		if (this.peek() !== '}') {
			unsupported();
		}
		this.pos += 1;

		if (max < min) {
			unsupported();
		}
		return clampRepeat(min, max, this.maxRepeat);
	}

	parseNumber() {
		const start = this.pos;
		while (/[0-9]/.test(this.peek() || '')) {
			this.pos += 1;
		}
		if (start === this.pos) {
			unsupported();
		}
		return Number(this.input.slice(start, this.pos));
	}

	expect(ch) {
		if (this.peek() !== ch) {
			unsupported();
		}
		this.pos += 1;
	}

	peek(offset = 0) {
		return this.input[this.pos + offset];
	}
}

function render(node, rng, state) {
	switch (node.type) {
		case 'lit':
			append(node.value, state);
			return;
		case 'class': {
			if (!node.chars.length) unsupported();
			const idx = randomInt(rng, 0, node.chars.length - 1);
			append(node.chars[idx], state);
			return;
		}
		case 'seq':
			for (const part of node.nodes) {
				render(part, rng, state);
			}
			return;
		case 'alt': {
			if (!node.choices.length) unsupported();
			const idx = randomInt(rng, 0, node.choices.length - 1);
			render(node.choices[idx], rng, state);
			return;
		}
		case 'repeat': {
			const count = randomInt(rng, node.min, node.max);
			for (let i = 0; i < count; i += 1) {
				render(node.node, rng, state);
			}
			return;
		}
		default:
			unsupported();
	}
}

function append(str, state) {
	if (state.outputLen + str.length > state.maxOutputLen) {
		throw new Error('max_output_len_exceeded');
	}
	state.output.push(str);
	state.outputLen += str.length;
}

export function mulberry32(seed) {
	let t = seed >>> 0;
	return function rng() {
		t += 0x6d2b79f5;
		let r = Math.imul(t ^ (t >>> 15), t | 1);
		r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

export function generateFromRule(rule, rng = Math.random, options = {}) {
	if (typeof rule !== 'string' || rule.length === 0) {
		unsupported();
	}

	const maxRepeat = Number.isFinite(options.maxRepeat) ? Number(options.maxRepeat) : 16;
	const maxOutputLen = Number.isFinite(options.maxOutputLen) ? Number(options.maxOutputLen) : 64;
	const parser = new Parser(rule, maxRepeat);
	const ast = parser.parse();
	const state = {
		maxOutputLen,
		output: [],
		outputLen: 0,
	};

	render(ast, typeof rng === 'function' ? rng : Math.random, state);
	return state.output.join('');
}
