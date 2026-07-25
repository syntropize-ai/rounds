import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 does not await route handlers, so a rejected promise from an
 * `async` handler is never routed to the error middleware — the response is
 * never written and the request hangs until the client times out.
 *
 * Wrap async handlers with this so rejections are forwarded to `next`, which
 * hands them to `errorHandler`. Handlers that already catch and respond on
 * their own are unaffected; this only covers the paths they miss.
 */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res, next).catch(next);
  };
}
