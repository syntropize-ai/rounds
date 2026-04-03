import type { Request, Response, NextFunction } from 'express';
export interface AuthenticatedRequest extends Request {
    auth?: {
        sub: string;
        type: 'jwt' | 'apikey';
        roles?: string[];
        permissions?: string[];
    };
}
export declare function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void;
//# sourceMappingURL=auth.d.ts.map