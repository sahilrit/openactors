import type { ActorContext } from '../../../../src/types.js';
/** Composes: runs another Actor and reshapes its results. */
export async function run(input: { n?: number }, ctx: ActorContext): Promise<void> {
    ctx.log('calling test/ok');
    const nested = await ctx.call('test/ok', { n: input.n ?? 2 });
    ctx.log(`nested run ${nested.status} with ${nested.itemCount} item(s)`);
    for (const item of nested.items) await ctx.pushData({ doubled: Number(item.i) * 2, from: nested.runId });
}
