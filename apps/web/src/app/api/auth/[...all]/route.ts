import { server } from "@/lib/server";

export const GET = (request: Request) => server().auth.handler(request);
export const POST = GET;
