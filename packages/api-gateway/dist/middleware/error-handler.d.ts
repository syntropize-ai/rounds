import type { Request, Response, NextFunction } from 'express';
export interface AppError extends Error {
    statusCode?: number;
    code?: string;
    /** If true, err.message is safe to expose to the client */
    isClientSafe?: boolean;
}
export declare function errorHandler(err: AppError, _req: Request, res: Response, _next: NextFunction): void;
export declare function notFoundHandler(req: Request, res: Response): void;
//# sourceMappingURL=error-handler.d.ts.map
