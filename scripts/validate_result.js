'use strict';
// Full Draft 2020-12 validation uses Python's jsonschema library, followed by
// domain relations below. Install jsonschema in your chosen Python environment;
// select it with INFO_MINIMALISM_PYTHON (default: python). PYTHONPATH is respected.
// Missing library/runtime yields exit 2, never a claim of schema conformance.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const schemaPath = path.resolve(__dirname, '../references/evaluation-result.schema.json');
const pythonProgram = `import json,sys
try:
 from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
 print(json.dumps({'unavailable':'Install jsonschema in INFO_MINIMALISM_PYTHON environment'})); sys.exit(2)
with open(sys.argv[1], encoding='utf-8') as f: schema=json.load(f)
Draft202012Validator.check_schema(schema)
data=json.load(sys.stdin)
errors=[{'path':'/'.join(map(str,e.absolute_path)), 'message':e.message} for e in Draft202012Validator(schema,format_checker=FormatChecker()).iter_errors(data)]
print(json.dumps({'errors':errors}))
`;
function validateSchema(data, options = {}) {
  const proc = spawnSync(options.python || process.env.INFO_MINIMALISM_PYTHON || 'python', ['-c', pythonProgram, schemaPath], {
    input: JSON.stringify(data), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: process.env, windowsHide: true
  });
  if (proc.error || proc.status !== 0) return { status: 'unavailable', errors: [], reason: proc.error?.message || proc.stdout || proc.stderr };
  try {
    const output = JSON.parse(proc.stdout);
    return { status: output.errors.length ? 'failed' : 'passed', errors: output.errors };
  } catch (error) { return { status: 'unavailable', errors: [], reason: error.message }; }
}
function validateRelations(d) {
  const errors = [];
  const fail = (at, message) => errors.push({ path: at, message });
  const same = (a,b) => a.scenario_id === b.scenario_id && a.rendering_id === b.rendering_id;
  const close = (a,b) => Math.abs(a-b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const reported = x => x?.status === 'reported';
  const number = x => reported(x) ? x.value : null;
  const unique = (rows,key,label) => {
    const map = new Map();
    for (const row of rows) { if (map.has(row[key])) fail(label, `Duplicate ${key}: ${row[key]}`); map.set(row[key], row); }
    return map;
  };
  const scenarios = unique(d.scenarios, 'scenario_id','scenarios');
  const renderings = unique(d.minimal_adequate_renderings, 'rendering_id','minimal_adequate_renderings');
  const meanings = unique(d.meaning_ledger,'id','meaning_ledger');
  const burdens = unique(d.burden_findings,'id','burden_findings');
  const gaps = unique(d.adequacy_gaps,'id','adequacy_gaps');
  const allocations = unique(d.crac_allocations,'allocation_id','crac_allocations');
  const allFindings = new Map([...burdens, ...gaps]);
  function checkLink(row, label) {
    if (!scenarios.has(row.scenario_id)) fail(label, 'Unknown scenario_id');
    if (row.rendering_id !== null) {
      const rendering = renderings.get(row.rendering_id);
      if (!rendering || rendering.scenario_id !== row.scenario_id) fail(label, 'Rendering missing or belongs to another scenario');
    }
  }
  for (const m of meanings.values()) for (const id of m.dependencies) if (!meanings.has(id)) fail(m.id, `Unknown meaning dependency ${id}`);
  for (const r of renderings.values()) {
    checkLink(r,r.rendering_id);
    for (const id of r.preserved_meaning_ids) if (!meanings.has(id)) fail(r.rendering_id, `Unknown preserved meaning ${id}`);
    if (r.fidelity === 'confirmed' && r.possible_losses.length) fail(r.rendering_id,'Confirmed fidelity cannot leave unresolved possible losses');
  }
  for (const b of burdens.values()) {
    checkLink(b,b.id);
    for (const id of b.meaning_ids) if (!meanings.has(id)) fail(b.id, `Unknown meaning reference ${id}`);
    if (b.disposition !== 'demonstrated' || b.confidence === 'low' || b.constraint_bound || b.resolution === 'resolved') {
      if (b.allocation_ids.length) fail(b.id,'Excluded, contested, low-confidence, constraint-bound, or resolved findings cannot allocate current CRAC');
    }
    let total = 0;
    for (const id of b.allocation_ids) {
      const a = allocations.get(id);
      if (!a || a.finding_id !== b.id || !same(a,b) || a.cost_basis !== b.cost_basis) fail(b.id,`Invalid allocation reference ${id}`);
      else total += a.removable_units;
    }
    if (b.allocation_ids.length && (!reported(b.removable_units) || !close(b.removable_units.value,total))) fail(b.id,'Finding savings must equal allocated net savings');
  }
  for (const g of gaps.values()) checkLink(g,g.id);
  for (const a of allocations.values()) {
    checkLink(a,a.allocation_id);
    const b = burdens.get(a.finding_id);
    if (!b || !b.allocation_ids.includes(a.allocation_id)) fail(a.allocation_id,'Allocation must be referenced by its finding');
    if (a.end <= a.start || !close(a.end-a.start,a.observed_units)) fail(a.allocation_id,'Half-open cost-unit interval must equal observed_units');
    if (!close(Math.max(0,a.observed_units-a.replacement_units),a.removable_units)) fail(a.allocation_id,'Net savings arithmetic is incorrect');
  }
  const rowKeys = new Set();
  const usedAllocations = new Set();
  for (const row of d.metrics.cost_metrics) {
    checkLink(row,'cost_metrics');
    const key = JSON.stringify([row.scenario_id,row.rendering_id,row.cost_basis]);
    if (rowKeys.has(key)) fail(key,'Duplicate cost row'); rowKeys.add(key);
    if (!d.measurement.cost_bases.includes(row.cost_basis)) fail(key,'Undeclared cost basis');
    const oac=number(row.observed_attention_cost), crac=number(row.conservative_removable_cost), ras=number(row.retained_attention_share);
    const rendering = renderings.get(row.rendering_id);
    if (d.artifact.access_status === 'unavailable') for (const metric of ['observed_attention_cost','mar_cost','conservative_removable_cost','adequacy_repair_cost','retained_attention_share']) {
      if (reported(row[metric])) fail(key,`Unavailable source requires withheld or not-applicable ${metric}`);
    }
    if (row.rendering_id === null && (reported(row.mar_cost) || crac !== null || ras !== null)) fail(key,'MAR, CRAC and RAS need an explicit rendering');
    if (rendering?.fidelity === 'failed' && (reported(row.mar_cost) || crac !== null || ras !== null)) fail(key,'Failed fidelity withholds MARC, CRAC and RAS');
    if (ras !== null && (oac === null || oac <= 0 || crac === null || d.evaluation_status === 'insufficient_context')) fail(key,'RAS requires positive reported OAC, reported CRAC, and sufficient context');
    if (crac !== null && oac !== null && crac > oac) fail(key,'CRAC exceeds observed cost');
    if (ras !== null && oac > 0 && crac !== null && !close(ras,(oac-crac)/oac)) fail(key,'RAS arithmetic is incorrect');
    const selected = [];
    for (const id of row.allocation_ids) {
      const a=allocations.get(id);
      if (!a || !same(a,row) || a.cost_basis !== row.cost_basis) { fail(key,`Invalid cost allocation ${id}`); continue; }
      if (usedAllocations.has(id)) fail(key,`Allocation used twice: ${id}`); usedAllocations.add(id); selected.push(a);
    }
    for (let i=0;i<selected.length;i++) for(let j=i+1;j<selected.length;j++) {
      const a=selected[i],b=selected[j];
      if (a.boundary_id===b.boundary_id && a.start < b.end && b.start < a.end) fail(key,`Overlapping allocations: ${a.allocation_id}, ${b.allocation_id}`);
    }
    if (crac !== null && !close(crac,selected.reduce((sum,a)=>sum+a.removable_units,0))) fail(key,'CRAC must equal allocated non-overlapping net savings');
    if (crac === null && selected.length) fail(key,'Withheld CRAC cannot contain counted allocations');
    const rowGaps=d.adequacy_gaps.filter(g=>same(g,row) && g.cost_basis===row.cost_basis && g.resolution==='unresolved');
    if (reported(row.adequacy_repair_cost)) {
      if (rowGaps.some(g=>!reported(g.repair_units))) fail(key,'Unknown repair cost requires withheld ARC');
      else if (!close(row.adequacy_repair_cost.value,rowGaps.reduce((sum,g)=>sum+g.repair_units.value,0))) fail(key,'ARC must equal unresolved repair costs');
    }
  }
  for (const id of allocations.keys()) if (!usedAllocations.has(id)) fail(id,'Orphan CRAC allocation');
  for (const row of d.metrics.diagnostics) {
    checkLink(row,'diagnostics');
    if (row.status==='reported' && (!row.cost_basis || !d.measurement.cost_bases.includes(row.cost_basis))) fail(row.name,'Reported diagnostic needs a declared cost basis');
    if (row.status==='reported' && row.rendering_id===null) fail(row.name,'Reported diagnostic needs explicit rendering linkage');
    if (row.status==='reported' && d.artifact.access_status==='unavailable') fail(row.name,'Unavailable source cannot report diagnostics');
    if (row.status==='reported' && ['payload_latency','cross_item_duplication','update_yield'].includes(row.name)) {
      if (row.numerator===null || row.denominator===null || row.denominator<=0 || !close(row.value,row.numerator/row.denominator)) fail(row.name,'Ratio diagnostic requires correct numerator/positive denominator');
      if (row.value>1) fail(row.name,'Share diagnostic cannot exceed one');
    }
    if (row.name==='fragmentation_overhead' && d.mode==='message' && row.status==='reported') fail(row.name,'Fragmentation requires sequence or channel boundary');
    if (['cross_item_duplication','update_yield'].includes(row.name) && d.mode!=='channel' && row.status==='reported') fail(row.name,'Channel diagnostic needs channel mode');
  }
  if (d.mode==='channel' && d.artifact.channel_sampling) {
    const s=d.artifact.channel_sampling;
    if (s.population_count!==null && s.sample_count>s.population_count) fail('channel_sampling','Sample exceeds population');
    if (d.artifact.part_count!==undefined && s.sample_count!==d.artifact.part_count) fail('channel_sampling','Part count and sample count disagree');
  }
  const latest=d.latest_standard;
  if (latest.installed_version!==d.standard_version) fail('latest_standard','Installed version must match evaluated Standard version');
  if (d.artifact.access_status==='unavailable' && (d.meaning_ledger.length || d.minimal_adequate_renderings.length || d.burden_findings.length || d.adequacy_gaps.length)) fail('artifact','Whole unavailable boundary cannot support meaning, rendering, or findings; use partial access for a separately inspectable excerpt');
  if (latest.status==='verified' && (!latest.latest_published_version || !latest.checked_at || !latest.source)) fail('latest_standard','Verified lookup requires release version, source, and timestamp');
  if (latest.status==='unverified' && latest.latest_published_version!==null) fail('latest_standard','Unverified latest version must be null');
  if (latest.latest_published_version && /(?:alpha|beta|rc|candidate)/i.test(latest.latest_published_version)) fail('latest_standard','Candidate/prerelease cannot be represented as latest published stable Standard');
  const q=d.qualification;
  if (q.artifact_identifier!==d.artifact.identifier || q.final_content!==d.artifact.content) fail('qualification','Qualification must identify the exact evaluated final artifact content');
  for (const id of q.scenario_ids) if (!scenarios.has(id)) fail('qualification',`Unknown qualified scenario ${id}`);
  for (const id of q.supporting_finding_ids) if (!allFindings.has(id)) fail('qualification',`Unknown supporting finding ${id}`);
  if (q.evaluation_complete !== (d.evaluation_status==='complete')) fail('qualification','Completion assertion disagrees with evaluation status');
  if (q.status==='meets_requirements') {
    if (!q.evaluation_complete || !q.meaning_function_confirmed || q.material_uncertainty || q.local_context_repair_needed !== false || d.artifact.access_status!=='complete') fail('qualification','P1 needs complete access/evaluation, confirmed meaning/function, no material uncertainty or local repair');
    for (const id of q.scenario_ids) {
      if (![...renderings.values()].some(r=>r.scenario_id===id && r.fidelity==='confirmed')) fail('qualification',`P1 needs confirmed rendering for ${id}`);
      if (d.burden_findings.some(b=>b.scenario_id===id && b.disposition==='demonstrated' && b.resolution==='unresolved' && b.confidence!=='low' && !b.constraint_bound)) fail('qualification',`Unresolved demonstrated high/medium burden in ${id}`);
      if (d.burden_findings.some(b=>b.scenario_id===id && b.disposition==='contested' && b.resolution==='unresolved' && b.material_to_qualification)) fail('qualification',`Material contested finding in ${id}`);
      if (d.burden_findings.some(b=>b.scenario_id===id && b.confidence==='low' && b.resolution==='unresolved' && b.disposition!=='excluded' && b.material_to_qualification)) fail('qualification',`Unresolved outcome-changing low-confidence finding in ${id}`);
      if (d.adequacy_gaps.some(g=>g.scenario_id===id && g.resolution==='unresolved')) fail('qualification',`Unresolved local context repair in ${id}`);
    }
  }
  return errors;
}
function validateResult(data,options={}) {
  const schema=validateSchema(data,options);
  const relations=schema.status==='passed' ? {status:'checked',errors:validateRelations(data)} : {status:'not_run',errors:[]};
  return {valid:schema.status==='passed' && !relations.errors.length,schema,relations};
}
if(require.main===module) {
  if(process.argv.length!==3) { console.error('Usage: node validate_result.js result.json'); process.exit(2); }
  try {
    const result=validateResult(JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,'')));
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.schema.status==='unavailable'?2:result.valid?0:1;
  } catch(error) {console.error(error.message);process.exitCode=2;}
}
module.exports={validateSchema,validateRelations,validateResult,schemaPath};
