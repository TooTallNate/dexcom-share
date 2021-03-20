/**
 * Author: Nathan Rajlich
 * https://github.com/TooTallNate
 *
 * Author: Ben West
 * https://github.com/bewest
 *
 * Advisor: Scott Hanselman
 * http://www.hanselman.com/blog/BridgingDexcomShareCGMReceiversAndNightscout.aspx
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @description: Logs in to Dexcom Share servers and reads blood glucose values.
 */
import ms from 'ms';
import qs from 'querystring';
import fetch from 'node-fetch';
import retry from 'async-retry';
import pluralize from 'pluralize';
import createDebug from 'debug';

const MS_PER_MINUTE = ms('1m');
const debug = createDebug('dexcom-share');
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const parseDate = (d: string): number => {
	const m = /Date\((.*)\)/.exec(d);
	return m ? parseInt(m[1], 10) : 0;
};
let isOutsideUs = false;

// Defaults
const Defaults = {
	baseUrl: 'https://share2.dexcom.com/ShareWebServices/Services',
	baseUrlOutsideUs: 'https://shareous1.dexcom.com/ShareWebServices/Services',
	applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
	agent: 'Dexcom Share/3.0.2.11 CFNetwork/711.2.23 Darwin/14.0.0',
	login: '/General/LoginPublisherAccountByName',
	accept: 'application/json',
	'content-type': 'application/json',
	LatestGlucose: '/Publisher/ReadPublisherLatestGlucoseValues',
	// ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
};

class AuthorizeError extends Error {
	constructor(data: string) {
		let message = data;
		let name = 'AuthorizeError';
		const matches = data.match(/\S+='(.*?)'/g);
		if (matches) {
			const content = matches.find((m) => m.startsWith('Content='));
			if (content) {
				const parsed = JSON.parse(
					content.substring(9, content.length - 1)
				);
				message = parsed.errors
					.join(' ')
					.replace(
						/([a-z])([A-Z])/g,
						(_: string, a: string, b: string) =>
							`${a} ${b.toLowerCase()}`
					);
				if (!message.endsWith('.')) {
					message += '.';
				}
			}

			const key = matches.find((m) => m.startsWith('Key='));
			if (key) {
				name = key.substring(5, key.length - 1).replace('SSO_', '');
			}
		}
		super(message);
		this.name = name;
	}
}

// Login to Dexcom's server.
async function authorize(
	opts: createDexcomShareIterator.AuthorizeOptions
): Promise<string> {
	isOutsideUs = !!opts.outsideUs;
	const url = `${isOutsideUs ? Defaults.baseUrlOutsideUs : Defaults.baseUrl}${Defaults.login}`;
	const payload = {
		password: opts.password,
		applicationId: opts.applicationId || Defaults.applicationId,
		accountName: opts.username || opts.accountName,
	};
	const headers = {
		'User-Agent': Defaults.agent,
		'Content-Type': Defaults['content-type'],
		Accept: Defaults.accept,
	};

	debug('POST %s', url);
	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(payload),
	});
	const body = await res.json();
	if (!res.ok) {
		throw new AuthorizeError(body.Message);
	}
	debug('Session ID: %o', body);
	return body;
}

async function getLatestReadings(
	opts: createDexcomShareIterator.GetLatestReadingsOptions
): Promise<createDexcomShareIterator.Reading[]> {
	const q = {
		sessionID: opts.sessionID,
		minutes: opts.minutes || 1440,
		maxCount: opts.maxCount || 1,
	};
	const url = `${isOutsideUs ? Defaults.baseUrlOutsideUs : Defaults.baseUrl}${Defaults.LatestGlucose}?${qs.stringify(q)}`;
	const headers = {
		'User-Agent': Defaults.agent,
		Accept: Defaults.accept,
	};
	debug('POST %s', url);
	const res = await fetch(url, {
		method: 'POST',
		headers,
	});
	if (!res.ok) {
		throw new Error(`${res.status} HTTP code`);
	}
	const readings: createDexcomShareIterator.Reading[] = await res.json();
	for (const reading of readings) {
		reading.Date = parseDate(reading.WT);
	}
	return readings;
}

async function login(opts: createDexcomShareIterator.AuthorizeOptions) {
	return retry<string>(
		async (bail) => {
			debug('Fetching new token');
			try {
				return await authorize(opts);
			} catch (err) {
				if (err instanceof AuthorizeError) {
					bail(err);
					return '';
				}
				throw err;
			}
		},
		{
			retries: 10,
			onRetry(err) {
				debug('Error refreshing token %o', err);
			},
		}
	);
}

async function _read(
	state: createDexcomShareIterator.IteratorState,
	_opts: createDexcomShareIterator.ReadOptions = {}
): Promise<createDexcomShareIterator.Reading[]> {
	if (!state.sessionId) {
		state.sessionId = login(state.config);
	}

	const opts = {
		maxCount: 1000,
		minutes: 1440,
		sessionID: await state.sessionId,
		..._opts,
	};

	const latestReadingDate = state.latestReading
		? state.latestReading.Date
		: 0;

	try {
		const readings = (await getLatestReadings(opts))
			.filter((reading) => reading.Date > latestReadingDate)
			.sort((a, b) => a.Date - b.Date);
		return readings;
	} catch (err) {
		debug('Read error: %o', err);
		state.sessionId = null;
		throw err;
	}
}

async function _wait({
	latestReading,
	config: { waitTime },
}: createDexcomShareIterator.IteratorState): Promise<number> {
	let diff = 0;
	if (latestReading) {
		diff = latestReading.Date + waitTime - Date.now();
		if (diff > 0) {
			debug('Waiting for %o', ms(diff));
			await sleep(diff);
		} else {
			debug(
				'No wait because last reading was %o ago',
				ms(-diff + waitTime)
			);
		}
	}
	return diff;
}

/**
 * Async iterator interface. Waits until the next estimated time that a Dexcom
 * reading will be uploaded, then reads the latest value from the Dexcom servers
 * repeatedly until one with a newer timestamp than the latest is returned.
 */
async function* _createDexcomShareIterator(
	state: createDexcomShareIterator.IteratorState
) {
	while (true) {
		await _wait(state);

		const readings = await retry(
			async () => {
				const opts: createDexcomShareIterator.ReadOptions = {};
				if (state.latestReading) {
					const msSinceLastReading =
						Date.now() - state.latestReading.Date;
					opts.minutes = Math.ceil(
						msSinceLastReading / MS_PER_MINUTE
					);
				} else {
					opts.maxCount = 1;
				}
				const r = await _read(state, opts);
				if (r.length === 0) {
					throw new Error('No new readings yet');
				}
				return r;
			},
			{
				retries: 1000,
				minTimeout: state.config.minTimeout,
				maxTimeout: state.config.maxTimeout,
				onRetry(err) {
					debug('Retrying from error', err);
				},
			}
		);

		debug(
			'Got %o new %s',
			readings.length,
			pluralize('reading', readings.length)
		);
		for (const reading of readings) {
			const latestReadingDate = state.latestReading
				? state.latestReading.Date
				: 0;
			if (reading.Date > latestReadingDate) {
				state.latestReading = reading;
				yield reading;
			} else {
				debug(
					'Skipping %o because the latest reading is %o',
					reading.Date,
					latestReadingDate
				);
			}
		}
	}
}

function createDexcomShareIterator(
	config: Partial<createDexcomShareIterator.IteratorOptions>
) {
	const state: createDexcomShareIterator.IteratorState = {
		config: Object.assign(
			{
				minTimeout: ms('5s'),
				maxTimeout: ms('5m'),
				waitTime: ms('5m') + ms('10s'),
			},
			config
		),
		latestReading: null,
		sessionId: null,
	};

	const iterator = _createDexcomShareIterator(
		state
	) as createDexcomShareIterator.DexcomShareIterator;

	/**
	 * Reads `count` blood glucose entries from Dexcom's servers, without any
	 * waiting. Advances the iterator such that the next call to `next()` will
	 * wait until after the newest entry from this `read()` call.
	 */
	iterator.read = async function read(
		opts: createDexcomShareIterator.ReadOptions
	): Promise<createDexcomShareIterator.Reading[]> {
		const readings = await _read(state, opts);
		if (readings && readings.length > 0) {
			debug(
				'Read %o %s',
				readings.length,
				pluralize('reading', readings.length)
			);
			state.latestReading = readings[readings.length - 1];
		}
		return readings;
	};

	/**
	 * Waits until 5 minutes (Dexcom records every 5 minutes), plus 10 seconds
	 * (to allow some time for the new reading to be uploaded) since the latest
	 * reading on this iterator.
	 */
	iterator.wait = function wait(): Promise<number> {
		return _wait(state);
	};

	/**
	 * Resets the iterator.
	 */
	iterator.reset = function reset(): void {
		state.latestReading = null;
	};

	return iterator;
}

namespace createDexcomShareIterator {
	export interface AuthorizeOptions {
		applicationId?: string;
		username?: string;
		accountName?: string;
		password?: string;
		outsideUs?: boolean;
	}

	export interface GetLatestReadingsOptions {
		sessionID: string;
		minutes?: number;
		maxCount?: number;
	}

	export interface ReadOptions {
		sessionID?: string;
		minutes?: number;
		maxCount?: number;
	}

	export interface IteratorOptions extends AuthorizeOptions {
		minTimeout: number;
		maxTimeout: number;
		waitTime: number;
	}

	export interface IteratorState {
		config: IteratorOptions;
		latestReading: null | Reading;
		sessionId: null | Promise<string>;
	}

	export enum Trend {
		None,
		DoubleUp,
		SingleUp,
		FortyFiveUp,
		Flat,
		FortyFiveDown,
		SingleDown,
		DoubleDown,
		NotComputable,
		OutOfRange,
	}

	export interface Reading {
		DT: string;
		ST: string;
		Trend: Trend;
		Value: number;
		WT: string;
		Date: number;
	}

	export interface DexcomShareIterator
		extends AsyncGenerator<Reading, void, unknown> {
		read(opts: ReadOptions): Promise<Reading[]>;
		wait(): Promise<number>;
		reset(): void;
	}
}

export = createDexcomShareIterator;
