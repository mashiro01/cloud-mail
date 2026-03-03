import BizError from '../error/biz-error';
import { isDel } from '../const/entity-const';
import settingService from './setting-service';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import { generateFromRule } from '../utils/regex-gen';
import saltHashUtils from '../utils/crypto-utils';
import roleService from './role-service';
import userService from './user-service';
import accountService from './account-service';
import orm from '../entity/orm';
import account from '../entity/account';
import user from '../entity/user';
import { eq } from 'drizzle-orm';

function toInt(v, def) {
	if (v === undefined || v === null || v === '') return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
}

function parseJsonArrayMaybe(str) {
	if (Array.isArray(str)) return str;
	if (typeof str !== 'string') return null;
	try {
		const parsed = JSON.parse(str);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function pickByRng(arr, rng) {
	if (!arr || arr.length === 0) return null;
	const idx = Math.floor(rng() * arr.length);
	return arr[Math.min(Math.max(idx, 0), arr.length - 1)];
}

function genPassword(rng, len) {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < len; i++) {
		out += chars.charAt(Math.floor(rng() * chars.length));
	}
	return out;
}

export async function batchRegisterImpl(input, deps) {
	const {
		n,
		rules,
		domainList,
		passwordLen,
		maxAttempts,
		maxRepeat,
		maxOutputLen,
		minEmailPrefix,
		emailPrefixFilter
	} = input;

	if (!Array.isArray(rules) || rules.length === 0) {
		throw new Error('invalid_env_rules');
	}
	if (!Array.isArray(domainList) || domainList.length === 0) {
		throw new Error('invalid_domain_list');
	}

	const requested = Number(n);
	if (!Number.isInteger(requested) || requested <= 0) {
		throw new Error('invalid_n');
	}

	const rng = deps.rng;
	if (typeof rng !== 'function') {
		throw new Error('invalid_rng');
	}

	const accounts = [];
	const failures = [];
	const createdEmails = new Set(); // lower-case

	let attempts = 0;
	while (accounts.length < requested && attempts < maxAttempts) {
		attempts++;

		const rule = pickByRng(rules, rng);
		if (!rule) {
			break;
		}

		let prefix;
		try {
			prefix = generateFromRule(rule, rng, { maxRepeat, maxOutputLen });
		} catch (e) {
			failures.push({
				rule,
				reason_code: e?.message === 'unsupported_regex' ? 'unsupported_regex' : 'generator_failed',
				message: e?.message || 'generator_failed'
			});
			continue;
		}

		if (typeof prefix !== 'string' || prefix.length === 0) {
			failures.push({ rule, reason_code: 'generator_failed', message: 'Empty prefix generated' });
			continue;
		}

		if (prefix.length < minEmailPrefix) {
			failures.push({ rule, reason_code: 'min_prefix_len', message: `Prefix too short (< ${minEmailPrefix})` });
			continue;
		}

		// Local-part max length enforcement (existing register logic uses 64).
		if (prefix.length > 64) {
			failures.push({ rule, reason_code: 'prefix_too_long', message: 'Prefix too long (> 64)' });
			continue;
		}

		if (Array.isArray(emailPrefixFilter) && emailPrefixFilter.some((s) => prefix.includes(s))) {
			failures.push({ rule, reason_code: 'prefix_filtered', message: 'Prefix contains filtered substring' });
			continue;
		}

		const domain = pickByRng(domainList, rng);
		const email = `${prefix}@${domain}`;

		if (!verifyUtils.isEmail(email)) {
			failures.push({ rule, email, reason_code: 'invalid_email', message: 'Generated email is invalid' });
			continue;
		}

		const emailKey = email.toLowerCase();
		if (createdEmails.has(emailKey)) {
			failures.push({ rule, email, reason_code: 'already_exists', message: 'Duplicate in this batch' });
			continue;
		}

		let taken = false;
		let deleted = false;
		try {
			taken = await deps.isEmailTaken(email);
			deleted = await deps.isEmailDeleted(email);
		} catch (e) {
			failures.push({ rule, email, reason_code: 'check_failed', message: e?.message || 'check_failed' });
			continue;
		}

		if (deleted) {
			failures.push({ rule, email, reason_code: 'deleted_not_reusable', message: 'Account is deleted and cannot be reused' });
			continue;
		}
		if (taken) {
			failures.push({ rule, email, reason_code: 'already_exists', message: 'Account already exists' });
			continue;
		}

		const password = genPassword(rng, passwordLen);
		try {
			const created = await deps.createAccount({ email, password, rule });
			createdEmails.add(emailKey);
			accounts.push(created);
		} catch (e) {
			const msg = e?.message || 'create_failed';
			const code =
				msg.includes('SQLITE_CONSTRAINT') || msg.includes('constraint') ? 'db_constraint' : 'create_failed';
			failures.push({ rule, email, reason_code: code, message: msg });
		}
	}

	if (accounts.length < requested) {
		failures.push({
			reason_code: 'exhausted_attempts',
			message: 'Unable to create enough unique accounts within attempt limits'
		});
	}

	return {
		requested,
		created: accounts.length,
		accounts,
		failures
	};
}

const batchRegisterService = {
	async batchRegister(c, params) {
		const env = c.env || {};

		const maxN = toInt(env.BATCH_REGISTER_MAX_N, 50);
		const passwordLen = toInt(env.BATCH_REGISTER_PASSWORD_LEN, 12);
		const maxRepeat = toInt(env.BATCH_REGISTER_MAX_REPEAT, 16);
		const maxOutputLen = toInt(env.BATCH_REGISTER_MAX_OUTPUT_LEN, 64);
		const pickDomainMode = (env.BATCH_REGISTER_PICK_DOMAIN || 'random').toLowerCase();

		const requestedN = toInt(params?.n, 0);
		if (!Number.isInteger(requestedN) || requestedN <= 0) {
			throw new BizError('n must be a positive integer');
		}
		const n = Math.min(requestedN, maxN);

		let rules = parseJsonArrayMaybe(env.BATCH_REGISTER_REGEX_RULES);
		if (!rules || rules.length === 0) {
			throw new BizError('BATCH_REGISTER_REGEX_RULES missing or invalid', 400);
		}
		rules = rules.map((s) => String(s)).filter(Boolean);

		// Domain list: support array value or JSON string.
		let domainList = env.domain;
		if (typeof domainList === 'string') {
			domainList = parseJsonArrayMaybe(domainList);
		}
		if (!Array.isArray(domainList) || domainList.length === 0) {
			throw new BizError('domain env var missing or invalid', 500);
		}

		// Settings for prefix rules.
		const setting = await settingService.query(c);
		const minEmailPrefix = toInt(setting?.minEmailPrefix, 1);
		const emailPrefixFilter = Array.isArray(setting?.emailPrefixFilter) ? setting.emailPrefixFilter : [];

		// Choose domain mode: if first, constrain domainList to [first].
		const normalizedDomains = domainList.map((d) => String(d)).filter(Boolean);
		const domainsForPick =
			pickDomainMode === 'first' ? normalizedDomains.slice(0, 1) : normalizedDomains;

		// Total attempt budget. Default: n * 20.
		const maxAttempts = toInt(env.BATCH_REGISTER_MAX_ATTEMPTS, n * 20);

		// Deterministic is not required for prod; use crypto.
		const rng = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

		const accountCache = new Map(); // lower-email -> { isDel, exists }
		async function getAccountState(email) {
			const key = email.toLowerCase();
			if (accountCache.has(key)) return accountCache.get(key);
			const row = await accountService.selectByEmailIncludeDel(c, email);
			const state = row
				? { exists: true, isDel: row.isDel }
				: { exists: false, isDel: null };
			accountCache.set(key, state);
			return state;
		}

		const defRoleRow = await roleService.selectDefaultRole(c);
		const defRoleId = defRoleRow?.roleId || 1;

		const res = await batchRegisterImpl(
			{
				n,
				rules,
				domainList: domainsForPick,
				passwordLen,
				maxAttempts,
				maxRepeat,
				maxOutputLen,
				minEmailPrefix,
				emailPrefixFilter
			},
			{
				rng,
				isEmailTaken: async (email) => {
					const st = await getAccountState(email);
					return st.exists && st.isDel !== isDel.DELETE;
				},
				isEmailDeleted: async (email) => {
					const st = await getAccountState(email);
					return st.exists && st.isDel === isDel.DELETE;
				},
				createAccount: async ({ email, password }) => {
					const { salt, hash } = await saltHashUtils.hashPassword(password);

					const userId = await userService.insert(c, {
						email,
						password: hash,
						salt,
						type: defRoleId,
						regKeyId: 0
					});

					try {
						await orm(c)
							.insert(account)
							.values({ userId, email, name: emailUtils.getName(email) })
							.returning()
							.get();
					} catch (e) {
						// Best-effort compensation to avoid orphans.
						try {
							await orm(c).delete(user).where(eq(user.userId, userId)).run();
						} catch {
							// ignore
						}
						throw e;
					}

					await userService.updateUserInfo(c, userId, true);
					accountCache.set(email.toLowerCase(), { exists: true, isDel: isDel.NORMAL });
					return { email, password };
				}
			}
		);

		return res;
	}
};

export default batchRegisterService;
