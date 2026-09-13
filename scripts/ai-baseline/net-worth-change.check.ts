/**
 * scripts/ai-baseline/net-worth-change.check.ts
 *
 * COMPOSITION IS NOT CHANGE, AND CHANGE IS NOT CAUSATION.
 *
 * The defect (58b352f, reproduced again after the paging fix): a tool named
 * `explain_net_worth_change` took one date, passed `fromISO === toISO`, returned
 * a COMPOSITION, and the model narrated a $12,345.80 savings BALANCE as "a big
 * chunk" of an $11,242.40 rise. A level is not a contribution to a change.
 *
 * The structural claims are pinned DB-free in baseline.test.ts §13k; this proves
 * the numbers against the real snapshot history, so it lives outside the DB-free
 * suite — the memory-store.check.ts precedent.
 *
 *   npm run ai:networth-change-check
 */

import { db } from '@/lib/db';
import '@/lib/ai/assemblers';
import { findTool, type ToolContext } from '@/scripts/ai-baseline/tools';
import type { SpaceContext } from '@/lib/space';
const SPACE='cmrrm846r000j7znwsl67gt1g';
let fail=0; const ck=(n:string,c:boolean,d?:string)=>{console.log((c?'  ✓ ':'  ✗ ')+n+(d?'  '+d:'')); if(!c)fail++;};
async function main(){
  const space=await db.space.findUniqueOrThrow({where:{id:SPACE}});
  const owner=await db.spaceMember.findFirstOrThrow({where:{spaceId:SPACE,role:'OWNER',status:'ACTIVE'}});
  const mk=(asOf:string):ToolContext=>({spaceId:SPACE,asOfISO:asOf,spaceCtx:{userId:owner.userId,spaceId:SPACE,role:'OWNER',
    permissions:{canInvite:true,canManage:true,canWrite:true,canRead:true,isOwner:true},
    space:{id:space.id,name:space.name,type:space.type,category:space.category,isPublic:space.isPublic,reportingCurrency:space.reportingCurrency}} as unknown as SpaceContext});
  type Pt = Record<string, number | null | string>;
  type Chg = { between:{from:string;to:string} } & Record<string, {from:number;to:number;abs:number;pct:number|null}>;
  type Hist = { first: Pt; last: Pt; change: Chg | null };
  const hist=(a:Record<string,unknown>,asOf='2026-09-12')=>
    findTool('get_net_worth_history')!.run(a,mk(asOf)) as Promise<Hist>;

  console.log('1. THE CHANGE IS COMPUTED, AND IT IS A DIFFERENCE');
  const r=await hist({from:'2026-08-12',to:'2026-09-12'});
  ck('a change block exists', r.change !== null, JSON.stringify(r.change?.between));
  if(!r.change){ console.log('\ncannot continue without a change block'); process.exit(1); }
  const c=r.change;
  const lastNum=(k:string)=>{ const v=r.last[k]; return typeof v==='number'?v:NaN; };
  for(const m of ['netWorth','liquid','investments','digitalAssets','debt']){
    if(!c[m]) { ck(`${m} present`, false); continue; }
    ck(`${m}.abs === to − from`, Math.abs(c[m].abs-(c[m].to-c[m].from))<0.005,
      `${c[m].from} → ${c[m].to} = ${c[m].abs}`);
  }
  ck('netWorth change matches first/last endpoints',
    Math.abs(c.netWorth.abs-(lastNum('netWorth')-(r.first.netWorth as number)))<0.005);
  ck('the effective observations are reported, not the requested dates',
    c.between.from===r.first.date && c.between.to===r.last.date,
    `${c.between.from}..${c.between.to} (asked 2026-08-12..2026-09-12)`);

  console.log('\n2. NO LEVEL EVER APPEARS IN A CHANGE FIELD');
  const levels=new Set(['netWorth','liquid','investments','digitalAssets','debt']
    .map(lastNum).filter(x=>Number.isFinite(x)&&x!==0));
  const absValues=['netWorth','liquid','investments','digitalAssets','debt']
    .filter(m=>c[m]).map(m=>c[m].abs);
  ck('no `abs` equals an ending balance',
    !absValues.some(v=>levels.has(v)), JSON.stringify(absValues));
  ck('`abs` is the only field named for movement — from/to are labelled as endpoints',
    Object.keys(c.netWorth).join(',')==='from,to,abs,pct');
  // Field NAMES, not the explanatory prose — the `meaning` string legitimately
  // uses the words it is warning against.
  const fieldNames = new Set<string>();
  const walk=(o:unknown):void=>{ if(!o||typeof o!=='object')return;
    for(const [k,v] of Object.entries(o as Record<string,unknown>)){ fieldNames.add(k); walk(v); } };
  walk(c);
  ck('no field is NAMED contribution / gain / cause',
    ![...fieldNames].some(k=>/contribution|gain|cause|driver|because/i.test(k)),
    [...fieldNames].join(','));
  ck('debt keeps its OWN direction, un-resigned',
    c.debt===undefined || Math.abs(c.debt.abs-(c.debt.to-c.debt.from))<0.005);

  console.log('\n3. COMPOSITION STILL HAS A TRUTHFUL PATH');
  const comp=await findTool('explain_net_worth_composition')!
    .run({date:'2026-09-12',lens:'net-worth'},mk('2026-09-12')) as { value: number };
  ck('explain_net_worth_composition resolves', typeof comp.value==='number', `value ${comp.value}`);
  ck('…and returns no change/delta field',
    !('change' in comp) && !/"(change|delta|abs)"/.test(JSON.stringify(comp)));
  ck('explain_net_worth_change is GONE from the surface',
    findTool('explain_net_worth_change')===undefined);

  console.log('\n4. INFORMATION CEILING');
  const retro=await hist({from:'2026-01-01',to:'2026-09-12'},'2026-01-31');
  ck('the closing observation never passes the ceiling',
    String(retro.last.date)<='2026-01-31', `last ${retro.last.date}`);
  ck('…and the change is measured between observations inside it',
    retro.change !== null && retro.change.between.to<='2026-01-31'
    && retro.change.between.from<='2026-01-31',
    `${retro.change?.between.from}..${retro.change?.between.to}`);
  ck('…and differs from the un-ceilinged answer',
    retro.change !== null && retro.change.netWorth.to!==c.netWorth.to);

  console.log('\n5. ONE OBSERVATION IS NOT A CHANGE');
  const single=await hist({from:'2026-09-12',to:'2026-09-12'});
  ck('a zero-width range refuses rather than reporting zeros',
    single.change===null, JSON.stringify(single.change));

  console.log('\n6. TOKEN COST');
  const before=JSON.stringify({ ...r, change: undefined });
  console.log(`  history payload without change: ~${Math.ceil(before.length/4)} tok`);
  console.log(`  with change:                    ~${Math.ceil(JSON.stringify(r).length/4)} tok`);
  console.log(fail===0?'\nALL PASSED':`\n${fail} FAILED`);
  await db.$disconnect(); process.exit(fail===0?0:1);
}
main();
