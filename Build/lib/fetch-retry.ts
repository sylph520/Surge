import picocolors from 'picocolors';
import {
  fetch,
  interceptors,
  EnvHttpProxyAgent,
  setGlobalDispatcher
} from 'undici';

import type { Response, RequestInit, RequestInfo } from 'undici';

import CacheableLookup from 'cacheable-lookup';
import type { LookupOptions as CacheableLookupOptions } from 'cacheable-lookup';

const cacheableLookup = new CacheableLookup();

const agent = new EnvHttpProxyAgent({
  // allowH2: true,
  connect: {
    lookup(hostname, opt, cb) {
      return cacheableLookup.lookup(hostname, opt as CacheableLookupOptions, cb);
    }
  }
});

setGlobalDispatcher(agent.compose(
  interceptors.retry({
    maxRetries: 5,
    minTimeout: 10000,
    // TODO: this part of code is only for allow more errors to be retried by default
    // This should be removed once https://github.com/nodejs/undici/issues/3728 is implemented
    // @ts-expect-error -- retry return type should be void
    retry(err, { state, opts }, cb) {
      const statusCode = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : null;
      const errorCode = 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
      const headers = ('headers' in err && typeof err.headers === 'object') ? err.headers : undefined;

      const { counter } = state;

      // Any code that is not a Undici's originated and allowed to retry
      if (
        errorCode === 'ERR_UNESCAPED_CHARACTERS'
        || err.message === 'Request path contains unescaped characters'
        || err.name === 'AbortError'
      ) {
        return cb(err);
      }

      if (errorCode !== 'UND_ERR_REQ_RETRY') {
        return cb(err);
      }

      const { method, retryOptions = {} } = opts;

      const {
        maxRetries = 5,
        minTimeout = 500,
        maxTimeout = 30 * 1000,
        timeoutFactor = 2,
        methods = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']
      } = retryOptions;

      // If we reached the max number of retries
      if (counter > maxRetries) {
        return cb(err);
      }

      // If a set of method are provided and the current method is not in the list
      if (Array.isArray(methods) && !methods.includes(method)) {
        return cb(err);
      }

      // bail out if the status code matches one of the following
      if (
        statusCode != null
        && (
          statusCode === 401 // Unauthorized, should check credentials instead of retrying
          || statusCode === 403 // Forbidden, should check permissions instead of retrying
          || statusCode === 404 // Not Found, should check URL instead of retrying
          || statusCode === 405 // Method Not Allowed, should check method instead of retrying
        )
      ) {
        return cb(err);
      }

      const retryAfterHeader = (headers as Record<string, string> | null | undefined)?.['retry-after'];
      let retryAfter = -1;
      if (retryAfterHeader) {
        retryAfter = Number(retryAfterHeader);
        retryAfter = Number.isNaN(retryAfter)
          ? calculateRetryAfterHeader(retryAfterHeader)
          : retryAfter * 1e3; // Retry-After is in seconds
      }

      const retryTimeout
        = retryAfter > 0
          ? Math.min(retryAfter, maxTimeout)
          : Math.min(minTimeout * (timeoutFactor ** (counter - 1)), maxTimeout);

      // eslint-disable-next-line sukka/prefer-timer-id -- won't leak
      setTimeout(() => cb(null), retryTimeout);
    }
    // errorCodes: ['UND_ERR_HEADERS_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'EPIPE', 'ETIMEDOUT']
  }),
  interceptors.redirect({
    maxRedirections: 5
  })
));

function calculateRetryAfterHeader(retryAfter: string) {
  const current = Date.now();
  return new Date(retryAfter).getTime() - current;
}

export class ResponseError extends Error {
  readonly res: Response;
  readonly code: number;
  readonly statusCode: number;
  readonly url: string;

  constructor(res: Response) {
    super(res.statusText);

    if ('captureStackTrace' in Error) {
      Error.captureStackTrace(this, ResponseError);
    }

    // eslint-disable-next-line sukka/unicorn/custom-error-definition -- deliberatly use previous name
    this.name = this.constructor.name;
    this.res = res;
    this.code = res.status;
    this.statusCode = res.status;
    this.url = res.url;
  }
}

export const defaultRequestInit: RequestInit = {
  headers: {
    'User-Agent': 'curl/8.9.1 (https://github.com/SukkaW/Surge)'
  }
};

export async function fetchWithLog(url: RequestInfo, opts: RequestInit = defaultRequestInit) {
  try {
    // this will be retried
    const res = (await fetch(url, opts));

    if (res.status >= 400) {
      throw new ResponseError(res);
    }

    if (!res.ok && res.status !== 304) {
      throw new ResponseError(res);
    }

    return res;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'name' in err) {
      if ((
        err.name === 'AbortError'
        || ('digest' in err && err.digest === 'AbortError')
      )) {
        console.log(picocolors.gray('[fetch abort]'), url);
      }
    } else {
      console.log(picocolors.gray('[fetch fail]'), url, { name: (err as any).name }, err);
    }

    throw err;
  }
};
