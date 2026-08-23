import type { ActorContext } from '../../../../src/types.js';
export async function run(input: { n?: number }, ctx: ActorContext): Promise<void> {
    ctx.log('starting');
    for (let i = 0; i < (input.n ?? 3); i++) await ctx.pushData({ i });
    ctx.log('done');
}
