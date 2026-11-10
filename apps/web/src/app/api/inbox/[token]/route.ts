// A webhook inbox (docs: Actions and delivery, "Webhook inbox (intake)"). The sign-in proxy leaves it
// out: the Inbox token in the path is the only proof. The path is never logged, since it holds the token.
import { itemEnqueuer } from "@watchdog/core";
import { receiveInbox } from "@/lib/inbox";
import { server } from "@/lib/server";

export async function POST(request: Request, { params }: RouteContext<"/api/inbox/[token]">) {
  const { token } = await params;
  const { db, boss } = server();
  // pg-boss starts only when an Item needs its job, so a failed start can't turn a 401 into a 500.
  return receiveInbox(db, { enqueueItems: async (tx, ids) => itemEnqueuer(await boss())(tx, ids) }, token, request);
}
