import "dotenv/config";

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';


const JWT_SECRET = process.env.JWT_SECRET;

// Extending the Request type so TypeScript knows req.userId exists
declare global {
    namespace Express {
        interface Request {
            userId?: number
        }
    }
}


// not proper error is showing to me -> when the password length is 6 -> error is TypeError: Cannot destructure property 'username' from null or undefined value

// how to know what this schema is string , number or what
export function validation(schema: any) {
    return (req: Request, res: Response, next: NextFunction) => {

        const result = schema.safeParse(req.body);      // whatever is coming from the req.body we will check is it safe or not

        if (!result.success) {
            return res.status(400).json({
                errors: result.error.errors             // what this will do btw
            })
        }
        req.body = result.data;         // so now we are storing result.data into the rea.body so we can do req.body and have all the content as we want
        next();
    }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {


    if (!JWT_SECRET) {
        throw new Error("JWT_SECRET environment variable is missing!");
    }

    const token = req.cookies.token;

    if (!token) {
        return res.status(401).json({
            message: "wrong token"
        })
    }

    let decoded;

    try {
        // 2. Verify the token
        decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

        if (!decoded || !decoded.userId) {
            return res.status(401).json({ message: "Invalid token payload" });
        }

        // 3. Attach the userId to the request
        req.userId = decoded.userId;
        next();
    } catch (err) {
        // 4. If verification fails, send a response so the client doesn't hang
        return res.status(401).json({ message: "Invalid token" });
    }

}