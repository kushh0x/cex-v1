import z from 'zod';

export const signupSchema = z.object({
    username: z.string().min(3, "Username must be at least 3 characters"),
    password: z.string().min(8, "password must be at least 8 characters"),
    // age: z.number().int().positive().optional()
})

export const signinSchema = z.object({
    username: z.string().min(3),        // i think we need 3 here because so that user don't enter 2 character user name
    password: z.string().min(8)         // same reason here for 8 i think so
})

