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
 * @description: Logs in to Dexcom Share2 servers and reads blood glucose values.
 */

const ms = require('ms');
const qs = require('querystring');
const crypto = require('crypto');
const fetch = require('node-fetch');
const sleep = require('then-sleep');
const retry = require('async-retry');
const debug = require('debug')('dexcom-share2');

module.exports = createIterator;

const parseDate = d => parseInt(/Date\((.*)\)/.exec(d)[1], 10);

// Defaults
const Defaults = {
  applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  agent: 'Dexcom Share/3.0.2.11 CFNetwork/711.2.23 Darwin/14.0.0',
  login:
    'https://share1.dexcom.com/ShareWebServices/Services/General/LoginPublisherAccountByName',
  accept: 'application/json',
  'content-type': 'application/json',
  LatestGlucose:
    'https://share1.dexcom.com/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues'
  // ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
};

// Login to Dexcom's server.
async function authorize(opts) {
  const url = Defaults.login;
  const body = {
    password: opts.password,
    applicationId: opts.applicationId || Defaults.applicationId,
    accountName: opts.username || opts.userName || opts.accountName
  };
  const headers = {
    'User-Agent': Defaults.agent,
    'Content-Type': Defaults['content-type'],
    Accept: Defaults.accept
  };

  debug('POST %s', url);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`${res.status} HTTP code`);
  }
  const sessionId = await res.json();
  debug('Session ID: %o', sessionId);
  return sessionId;
}

async function getLatestReadings(opts) {
  // ?sessionID=e59c836f-5aeb-4b95-afa2-39cf2769fede&minutes=1440&maxCount=1"
  const q = {
    sessionID: opts.sessionID,
    minutes: opts.minutes || 1440,
    maxCount: opts.maxCount || 1
  };
  const url = Defaults.LatestGlucose + '?' + qs.stringify(q);
  const headers = {
    'User-Agent': Defaults.agent,
    Accept: Defaults.accept
  };
  debug('POST %s', url);
  const res = await fetch(url, {
    method: 'POST',
    headers
  });
  if (!res.ok) {
    throw new Error(`${res.status} HTTP code`);
  }
  const readings = await res.json();
  for (const reading of readings) {
    reading.Date = parseDate(reading.WT);
  }
  return readings;
}

function createIterator(opts) {
  let latest;
  let sessionId;

  async function login() {
    return retry(
      () => {
        debug('Fetching new token');
        return authorize(opts);
      },
      {
        retries: 10,
        onRetry(err) {
          debug('Error refreshing token %o', err);
        }
      }
    );
  }

  async function _read(count = 1) {
    if (!sessionId) {
      sessionId = login();
    }

    const fetchOpts = {
      maxCount: count,
      minutes: 1440,
      sessionID: await sessionId
    };
    try {
      const readings = await getLatestReadings(fetchOpts);
      return readings;
    } catch (err) {
      debug('read(%o)', err);
      sessionId = null;
    }
  }

  /**
   * Reads `count` blood glucose entries from Dexcom's servers, without any
   * waiting. Advances the iterator such that the next call to `next()` will
   * wait until after the newest entry from this `read()` call.
   */
  async function read(...args) {
    const readings = await _read(...args);
    if (readings && readings.length > 0) {
      latest = readings[0];
    }
    return readings;
  }

  /**
   * Async iterator interface. Waits until the next estimated time that a Dexcom
   * reading will be uploaded, then reads the latest value from the Dexcom servers
   * repeatedly until one with a newer timestamp than the latest is returned.
   */
  async function next() {
    await wait();

    const value = await retry(
      async () => {
        const [reading] = await _read(1);
        if (latest && latest.Date === reading.Date) {
          throw new Error('Retrying because no new reading yet');
        }
        latest = reading;
        return reading;
      },
      {
        retries: 100, // Infinity?
        minTimeout: ms('5s'),
        maxTimeout: ms('1m'),
        onRetry(err) {
          debug('Retrying from error %o', String(err));
        }
      }
    );
    return { done: false, value };
  }

  /**
   * Waits until 5 minutes (Dexcom records every 5 minutes), plus 10 seconds
   * (to allow some time for the new reading to be uploaded) since the latest
   * reading on this iterator.
   */
  async function wait() {
    let diff = 0;
    if (latest) {
      diff = latest.Date + ms('5m') + ms('10s') - Date.now();
      if (diff > 0) {
        debug('Waiting for %o', ms(diff));
        await sleep(diff);
      } else {
        debug('Waiting diff %o', diff);
      }
    }
    return diff;
  }

  return {
    next,
    read,
    wait
  };
}
