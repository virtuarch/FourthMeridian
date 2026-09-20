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
 * ⚠️ NO DATE IS WRITTEN DOWN, AND NO METRIC IS PRESUMED ESTABLISHED. The first
 * version read as of 2026-09-12 over 2026-08-12..09-12 with a January ceiling, and
 * demanded all five metrics in the change block. No money was pinned, but two
 * assumptions about the live Space were: that those months stay inside the
 * snapshot read, and that crypto is valued at both ends (it is OMITTED, by
 * design, when it is not — and this Space's ETH history has been pending before).
 * The as-of is today (or `CHECK_AS_OF`), every window is derived from it, and a
 * metric's presence is asserted as the contract states it: present exactly when
 * both endpoints carry a number. Every assertion is a relation inside one payload
 * or between two reads; nothing is compared with a remembered figure.
 *
 *   npm run ai:networth-change-check
 */

import { db } from '@/lib/db';
import '@/lib/ai/assemblers';
import { findTool, type ToolContext } from '@/lib/ai/conversation/tools';
import type { SpaceContext } from '@/lib/space';
const SPACE=process.env.CHECK_SPACE_ID ?? 'cmrrm846r000j7znwsl67gt1g';
const ASOF=process.env.CHECK_AS_OF ?? new Date().toISOString().slice(0,10);
const shift=(iso:string,days:number)=>new Date(Date.parse(`${iso}T00:00:00Z`)+days*86_400_000).toISOString().slice(0,10);
/** A month back; and a ceiling some seven months back with a month before it — the original's shape. */
const FROM=shift(ASOF,-31), CEILING=shift(ASOF,-224), RETRO_FROM=shift(CEILING,-30);
const METRICS=['netWorth','liquid','investments','digitalAssets','debt'] as const;
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
  const hist=(a:Record<string,unknown>,asOf=ASOF)=>
    findTool('get_net_worth_history')!.run(a,mk(asOf)) as Promise<Hist>;

  console.log(`Space ${SPACE} as of ${ASOF}: ${FROM}..${ASOF}; retrospective ceiling ${CEILING}\n`);
  console.log('1. THE CHANGE IS COMPUTED, AND IT IS A DIFFERENCE');
  const r=await hist({from:FROM,to:ASOF});
  ck('a change block exists', r.change !== null, JSON.stringify(r.change?.between));
  if(!r.change){ console.log('\ncannot continue without a change block'); process.exit(1); }
  const c=r.change;
  const lastNum=(k:string)=>{ const v=r.last[k]; return typeof v==='number'?v:NaN; };
  ck('the range holds two different observations to subtract', r.first.date!==r.last.date, `${r.first.date} → ${r.last.date}`);
  for(const m of METRICS){
    // ⚠️ PRESENT EXACTLY WHEN ESTABLISHED AT BOTH ENDS. "Not established" and "did
    // not move" are different answers, so an unestablished metric is OMITTED — and
    // one that IS established at both ends must never be missing.
    const established=typeof r.first[m]==='number' && typeof r.last[m]==='number';
    ck(`${m} is ${established?'present: established at both ends':'OMITTED: not established at both ends'}`, (c[m]!==undefined)===established);
    if(!c[m]) continue;
    ck(`${m}.abs === to − from`, Math.abs(c[m].abs-(c[m].to-c[m].from))<0.005,
      `${c[m].from} → ${c[m].to} = ${c[m].abs}`);
    ck(`${m} from/to ARE the first and last observations`, c[m].from===r.first[m] && c[m].to===r.last[m]);
  }
  ck('at least the bank-side metrics are established — the block is not empty', c.liquid!==undefined && c.debt!==undefined);
  ck('netWorth change matches first/last endpoints',
    c.netWorth===undefined || Math.abs(c.netWorth.abs-(lastNum('netWorth')-(r.first.netWorth as number)))<0.005);
  ck('the effective observations are reported, not the requested dates',
    c.between.from===r.first.date && c.between.to===r.last.date,
    `${c.between.from}..${c.between.to} (asked ${FROM}..${ASOF})`);

  console.log('\n2. NO LEVEL EVER APPEARS IN A CHANGE FIELD');
  const levels=new Set(METRICS.map(lastNum).filter(x=>Number.isFinite(x)&&x!==0));
  const absValues=METRICS.filter(m=>c[m]).map(m=>c[m].abs);
  ck('no `abs` equals an ending balance',
    !absValues.some(v=>levels.has(v)), JSON.stringify(absValues));
  ck('`abs` is the only field named for movement — from/to are labelled as endpoints',
    METRICS.filter(m=>c[m]).every(m=>Object.keys(c[m]).join(',')==='from,to,abs,pct'));
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
    .run({date:String(r.last.date),lens:'net-worth'},mk(ASOF)) as { value: number };
  ck('explain_net_worth_composition resolves', typeof comp.value==='number', `value ${comp.value}`);
  ck('…to the LEVEL the history closes on — two tools, one net worth, and it is not the change',
    !Number.isFinite(lastNum('netWorth')) || (Math.abs(comp.value-lastNum('netWorth'))<0.0051 && comp.value!==c.netWorth?.abs),
    `${comp.value} vs ${lastNum('netWorth')}`);
  ck('…and returns no change/delta field',
    !('change' in comp) && !/"(change|delta|abs)"/.test(JSON.stringify(comp)));
  ck('explain_net_worth_change is GONE from the surface',
    findTool('explain_net_worth_change')===undefined);

  console.log('\n4. INFORMATION CEILING');
  const retro=await hist({from:RETRO_FROM,to:ASOF},CEILING);
  ck('the closing observation never passes the ceiling',
    String(retro.last.date)<=CEILING, `last ${retro.last.date}`);
  ck('…and the change is measured between observations inside it',
    retro.change !== null && retro.change.between.to<=CEILING
    && retro.change.between.from<=CEILING && retro.change.between.from>=RETRO_FROM,
    `${retro.change?.between.from}..${retro.change?.between.to}`);
  const open=await hist({from:RETRO_FROM,to:ASOF});
  ck('…and differs from the un-ceilinged answer to the SAME request',
    retro.change !== null && open.change !== null && open.change.between.to>CEILING
    && open.change.between.to!==retro.change.between.to,
    `${open.change?.between.to} without the ceiling`);
  ck('…while the opening observation — the past — is the same in both', open.change?.between.from===retro.change?.between.from);

  console.log('\n5. ONE OBSERVATION IS NOT A CHANGE');
  const single=await hist({from:String(r.last.date),to:String(r.last.date)});
  ck('the one-day range did find its observation', single.first?.date===r.last.date && single.last?.date===r.last.date);
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
