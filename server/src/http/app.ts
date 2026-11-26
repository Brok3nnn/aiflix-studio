import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import type { StudioInfoDto } from '../../../shared/api.ts';
import { HTTP_STATUS, StudioError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import { apiRouter, type ApiDeps } from './routes.ts';

export interface AppOptions extends ApiDeps {
  generatedDir: string;
  /** Built web client to serve at `/`, if any (`npm run build`). */
  webDir?: string | null;
  /** Bound address. When it is a loopback address, requests for other host names are refused. */
  host: string;
  logger: Logger;
  studioInfo: () => StudioInfoDto;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  if (isLoopback(options.host)) app.use(localHostOnly);

  app.use('/api', express.json({ limit: '32kb' }), apiRouter(options));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
  app.use(
    '/media',
    express.static(options.generatedDir, { index: false, dotfiles: 'ignore', fallthrough: false }),
  );
  if (options.webDir) app.use(express.static(options.webDir));

  app.use(errorHandler(options.logger));
  return app;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopback(host: string): boolean {
  return LOOPBACK_NAMES.has(host.toLowerCase());
}

/** The host name of a Host header, without the port: `[::1]:3001` gives `[::1]`. */
export function hostName(header: string | undefined): string {
  if (!header) return '';
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0] ?? '';
}

/**
 * A server bound to loopback only answers requests addressed to a loopback name. This blocks
 * DNS-rebinding pages from driving the API (and spending API credit) through the browser.
 */
const localHostOnly: RequestHandler = (req, res, next) => {
  if (isLoopback(hostName(req.headers.host))) {
    next();
    return;
  }
  res.status(403).json({ error: 'This local server only accepts requests for localhost.' });
};

function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof StudioError) {
      res.status(HTTP_STATUS[error.code]).json({ error: error.message });
      return;
    }
    const { status, type } = httpErrorInfo(error);
    if (status !== null && status >= 400 && status < 500) {
      res.status(status).json({ error: clientErrorMessage(status, type) });
      return;
    }
    logger.error(`Unhandled error on ${req.method} ${req.path}`, error);
    res.status(500).json({ error: 'Internal server error.' });
  };
}

/** Status and type carried by errors from Express middleware (body parser, static files). */
function httpErrorInfo(error: unknown): { status: number | null; type: string | null } {
  if (typeof error !== 'object' || error === null) return { status: null, type: null };
  const { status, statusCode, type } = error as { status?: unknown; statusCode?: unknown; type?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return {
    status: typeof value === 'number' ? value : null,
    type: typeof type === 'string' ? type : null,
  };
}

function clientErrorMessage(status: number, type: string | null): string {
  if (type === 'entity.parse.failed') return 'The request body must be valid JSON.';
  if (status === 413) return 'The request body is too large.';
  if (status === 404) return 'Not found.';
  return 'Bad request.';
}
