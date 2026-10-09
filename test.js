/**
 * Client Intake Gap Finder: Test Suite
 * Explicitly tests every specified failure mode:
 * 1. Missing columns
 * 2. Duplicate IDs
 * 3. Blanks
 * 4. Invalid dates
 * 5. Timezone handling (date stability across offsets)
 * 6. Completed cases (accuracy of complete detection)
 * 7. HTML / Formula injection safety in CSV export
 * 8. Entirely missing required item (source has no row for item)
 * 9. Safe CSV exports (prefix = + - @)
 * 10. Network check (offline / client-side execution verification)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Engine = require('./logic.js');

console.log('Running Client Intake Gap Finder test suite...');

// Test 1: Missing columns
{
  const rows = [
    { ColA: 'CASE-1', ColB: 'Item-1' }
  ];
  // Attempt mapping without required caseId or requiredItem
  const res1 = Engine.analyzeIntake(rows, { caseId: '', requiredItem: 'ColB' });
  assert.strictEqual(res1.cases.length, 0);
  assert.ok(res1.error.includes('Missing required column mapping'));

  const res2 = Engine.analyzeIntake(rows, { caseId: 'ColA', requiredItem: '' });
  assert.strictEqual(res2.cases.length, 0);
  assert.ok(res2.error.includes('Missing required column mapping'));
  console.log('✓ PASS: Missing column mapping validation');
}

// Test 2: Duplicate IDs (duplicate item rows within same case with conflicting or matching status)
{
  const rows = [
    { id: 'C-1', item: 'ID Document', status: 'Received', owner: 'Alice' },
    { id: 'C-1', item: 'ID Document', status: 'Missing', owner: 'Alice' }
  ];
  const res = Engine.analyzeIntake(rows, { caseId: 'id', requiredItem: 'item', status: 'status', owner: 'owner' });
  const c = res.cases[0];
  assert.strictEqual(c.inconsistentCount, 1);
  assert.strictEqual(c.inconsistentItems[0].hasInconsistentStatus, true);
  assert.ok(res.validationIssues.some(v => v.type === 'inconsistent_status'));
  console.log('✓ PASS: Duplicate item IDs with conflicting status detected');
}

// Test 3: Blanks (blank case IDs, blank item names, blank owners)
{
  const rows = [
    { id: '', item: 'Tax Form', status: 'Pending', owner: 'Bob' },
    { id: 'C-2', item: '   ', status: 'Pending', owner: 'Bob' },
    { id: 'C-3', item: 'Passport', status: 'Pending', owner: '' }
  ];
  const res = Engine.analyzeIntake(rows, { caseId: 'id', requiredItem: 'item', status: 'status', owner: 'owner' });
  assert.strictEqual(res.cases.length, 1); // C-3 made it through; blank id & blank item rejected
  assert.strictEqual(res.cases[0].caseId, 'C-3');
  assert.strictEqual(res.cases[0].unownedCount, 1);
  assert.ok(res.validationIssues.some(v => v.type === 'blank_case_id'));
  assert.ok(res.validationIssues.some(v => v.type === 'blank_item'));
  console.log('✓ PASS: Blank case IDs and blank items flagged and handled gracefully');
}

// Test 4: Invalid dates
{
  const rows = [
    { id: 'C-4', item: 'ID', status: 'Pending', due: '2026-02-31' }, // Invalid calendar day
    { id: 'C-4', item: 'Tax', status: 'Pending', due: 'not-a-real-date' },
    { id: 'C-4', item: 'Proof', status: 'Pending', due: '2026-09-15' }
  ];
  const res = Engine.analyzeIntake(rows, { caseId: 'id', requiredItem: 'item', status: 'status', dueDate: 'due' });
  assert.ok(res.validationIssues.some(v => v.type === 'invalid_date' && v.message.includes('not-a-real-date')));
  assert.ok(res.validationIssues.some(v => v.type === 'invalid_date' && v.message.includes('2026-02-31')));
  console.log('✓ PASS: Invalid dates properly detected without crashing');
}

// Test 5: Timezone handling
{
  // A string '2026-09-20' must produce the exact calendar date September 20, 2026 in UTC
  const parsed = Engine.parseDateSafe('2026-09-20');
  assert.strictEqual(parsed.getUTCFullYear(), 2026);
  assert.strictEqual(parsed.getUTCMonth(), 8); // 0-indexed September
  assert.strictEqual(parsed.getUTCDate(), 20);

  // US format 09/20/2026
  const parsedUS = Engine.parseDateSafe('09/20/2026');
  assert.strictEqual(parsedUS.getUTCFullYear(), 2026);
  assert.strictEqual(parsedUS.getUTCMonth(), 8);
  assert.strictEqual(parsedUS.getUTCDate(), 20);
  console.log('✓ PASS: Timezone safety verified (calendar date stability in UTC)');
}

// Test 6: Completed cases
{
  const rows = [
    { id: 'C-DONE', item: 'ID Document', status: 'Received' },
    { id: 'C-DONE', item: 'W-9 Form', status: 'Completed' },
    { id: 'C-NOT-DONE', item: 'ID Document', status: 'Received' },
    { id: 'C-NOT-DONE', item: 'W-9 Form', status: 'Missing' }
  ];
  const res = Engine.analyzeIntake(rows, { caseId: 'id', requiredItem: 'item', status: 'status' });
  assert.strictEqual(res.summary.completedCases, 1);
  assert.strictEqual(res.summary.openCases, 1);
  const doneCase = res.cases.find(c => c.caseId === 'C-DONE');
  assert.strictEqual(doneCase.isComplete, true);
  const notDoneCase = res.cases.find(c => c.caseId === 'C-NOT-DONE');
  assert.strictEqual(notDoneCase.isComplete, false);
  console.log('✓ PASS: Completed cases detected accurately');
}

// Test 7 & 9: HTML and Formula injection safety in CSV exports
{
  const rawValues = [
    '=1+1',
    '+12345',
    '-cmd|"/C calc"!A0',
    '@SUM(A1:A10)',
    '\tDDE("cmd")',
    '<script>alert(1)</script>',
    'Normal text'
  ];

  for (const val of ['=1+1', '+12345', '-cmd', '@SUM', '\tDDE']) {
    const sanitized = Engine.sanitizeForCSV(val);
    assert.strictEqual(sanitized.charAt(0), "'", `Should prepend quote for ${val}`);
  }

  const sanitizedNormal = Engine.sanitizeForCSV('Normal text');
  assert.strictEqual(sanitizedNormal, 'Normal text');

  const headers = ['Case', 'Payload'];
  const testRows = [
    { Case: 'C-HACK', Payload: '=cmd|"/C calc"!A0' },
    { Case: 'C-XSS', Payload: '<script>alert("xss")</script>' }
  ];
  const csvOut = Engine.exportSafeCSV(headers, testRows);
  assert.ok(csvOut.includes("'=cmd|"), 'Formula injection must be prepended with quote');
  assert.ok(csvOut.includes('<script>alert(""xss"")</script>'), 'HTML must be safely quoted in CSV cell');
  console.log('✓ PASS: HTML and formula injection defenses verified');
}

// Test 8: Entirely missing required item (source has no row for it)
{
  // Source table only has received items!
  const rows = [
    { id: 'C-50', item: 'ID Document', status: 'Received' }
  ];
  // Required list says we also require 'Proof of Address' and 'W-9 Form'
  const requiredList = ['ID Document', 'Proof of Address', 'W-9 Form'];
  const res = Engine.analyzeIntake(rows, { caseId: 'id', requiredItem: 'item', status: 'status' }, {
    requiredItemsList: requiredList
  });

  const c = res.cases[0];
  assert.strictEqual(c.totalItemsCount, 3);
  assert.strictEqual(c.completedCount, 1);
  assert.strictEqual(c.missingCount, 2);
  assert.strictEqual(c.isComplete, false);
  assert.strictEqual(res.summary.completedCases, 0);

  const missingNames = c.missingItems.map(m => m.item);
  assert.ok(missingNames.includes('Proof of Address'));
  assert.ok(missingNames.includes('W-9 Form'));
  console.log('✓ PASS: Entirely missing required items (absent rows) correctly identified');
}

// Test 10: Network check (verify no remote network endpoints in code / privacy check)
{
  const logicContent = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
  assert.ok(!logicContent.includes('fetch('), 'logic.js must not contain fetch()');
  assert.ok(!logicContent.includes('XMLHttpRequest'), 'logic.js must not contain XMLHttpRequest');
  assert.ok(!logicContent.includes('http://'), 'logic.js must not contain remote http links');
  assert.ok(!logicContent.includes('https://'), 'logic.js must not contain remote https links');
  console.log('✓ PASS: Zero-network transmission verified in engine');
}



// ---------------------------------------------------------------------------
// GTM-103 regressions. Every block targets one way the tool can fail.
//
// Failure modes written down before the logic changed:
//  F1  A real "received" synonym (Uploaded, Signed, Submitted...) is not understood.
//  F2  Status matching breaks on case, spacing, hyphens, underscores or trailing punctuation.
//  F3  An unknown status is reported as an "inconsistent" duplicate instead of "needs review".
//  F4  An unknown status is called overdue or missing, which it cannot know.
//  F5  N/A items land on the worklist.
//  F6  A real contradiction (Received vs Missing) stops being reported.
//  F7  The tracker says "W-9" and the checklist says "W-9 Form": a false "unrecorded" gap appears.
//  F8  Name normalisation misses case, punctuation, hyphens, form/copy suffixes or plurals.
//  F9  A loose match (Photo ID vs Government Photo ID) silently decides instead of going to review.
//  F10 A genuinely absent checklist item stops being reported as unrecorded.
//  F11 Two different documents get merged by an over-eager match.
//  F12 A client email asks for something the client already provided or that only an uncertain match flagged.
//  F13 A client email asks for an item whose rows contradict each other.
//  F14 "1 items" grammar.
//  F15 A case with an item awaiting review is called complete.
//  F16 Only-uncertain cases still produce a draft email.
//  F17 The hosted CTA points at the homepage or lacks the UTM tags.
// ---------------------------------------------------------------------------

const MAP = { caseId: 'id', requiredItem: 'item', status: 'status', dueDate: 'due', owner: 'owner' };
const REF = new Date('2026-10-09T00:00:00Z');
const run = (rows, requiredItemsList) =>
  Engine.analyzeIntake(rows, MAP, { referenceDate: REF, requiredItemsList: requiredItemsList || [] });
const wl = (res, item) => res.worklist.find(w => w.item === item);

// F1 + F2: received synonyms, in messy spellings
{
  const received = ['Uploaded', 'Signed', 'Submitted', 'Complete', 'Completed', 'Approved', 'Done', 'Received',
    ' UPLOADED ', 'uploaded.', 'signed', 'N/A', 'n/a', 'NA', 'Not Applicable'];
  for (const s of received) {
    assert.strictEqual(Engine.normalizeStatus(s), 'complete', 'complete: ' + JSON.stringify(s));
  }
  for (const s of ['Pending', 'Requested', 'In Progress', 'in_progress', 'In-Progress', 'PENDING ']) {
    assert.strictEqual(Engine.normalizeStatus(s), 'pending', 'pending: ' + JSON.stringify(s));
  }
  for (const s of ['Missing', 'MISSING', ' missing ', 'Not Started', 'not_started', 'Outstanding']) {
    assert.strictEqual(Engine.normalizeStatus(s), 'missing', 'missing: ' + JSON.stringify(s));
  }
  assert.strictEqual(Engine.normalizeStatus(''), 'missing', 'blank status stays missing');
  console.log('PASS: status synonyms are case, space and punctuation insensitive');
}

// F3 + F4: unknown status goes to needs review, not inconsistent, overdue or missing
{
  assert.strictEqual(Engine.normalizeStatus('Waiting on counsel'), 'needs_review');
  const res = run([{ id: 'C1', item: 'Trust Deed', status: 'Waiting on counsel', due: '2026-09-01', owner: 'Ana' }]);
  const w = wl(res, 'Trust Deed');
  assert.strictEqual(w.normStatus, 'needs_review');
  assert.strictEqual(w.priority, 'Review');
  assert.strictEqual(w.inconsistent, false);
  assert.strictEqual(w.isOverdue, false);
  assert.ok(/needs review/i.test(w.reason), w.reason);
  assert.ok(!/inconsistent|overdue|missing/i.test(w.reason), w.reason);
  assert.strictEqual(res.summary.totalInconsistent, 0);
  assert.strictEqual(res.summary.totalOverdue, 0);
  assert.strictEqual(res.summary.totalGaps, 0);
  assert.strictEqual(res.summary.totalNeedsReview, 1);
  console.log('PASS: unknown status becomes needs review');
}

// F1 (audit fixture): "Uploaded" past its due date is not overdue or inconsistent
{
  const res = run([{ id: 'Harlow Trust', item: 'Proof of Address', status: 'Uploaded', due: '2026-09-25', owner: 'Dana Reyes' }]);
  assert.strictEqual(res.worklist.length, 0);
  assert.strictEqual(res.summary.totalOverdue, 0);
  assert.strictEqual(res.summary.totalInconsistent, 0);
  assert.strictEqual(res.cases[0].isComplete, true);
  console.log('PASS: audit fixture, "Uploaded" is not flagged inconsistent or overdue');
}

// F5: N/A never reaches the worklist
{
  const res = run([{ id: 'C1', item: 'Trust Deed', status: 'N/A', due: '2026-01-01', owner: '' }]);
  assert.strictEqual(res.worklist.length, 0);
  console.log('PASS: N/A items are resolved');
}

// F6: a real contradiction is still reported, and a harmless duplicate is not
{
  const real = run([
    { id: 'C1', item: 'ID', status: 'Received', due: '', owner: 'A' },
    { id: 'C1', item: 'ID', status: 'Missing', due: '', owner: 'A' }
  ]);
  assert.strictEqual(real.summary.totalInconsistent, 1);
  const same = run([
    { id: 'C1', item: 'ID', status: 'Uploaded', due: '', owner: 'A' },
    { id: 'C1', item: 'ID', status: 'Received', due: '', owner: 'A' }
  ]);
  assert.strictEqual(same.summary.totalInconsistent, 0);
  const unknown = run([
    { id: 'C1', item: 'ID', status: 'Received', due: '', owner: 'A' },
    { id: 'C1', item: 'ID', status: 'Parked', due: '', owner: 'A' }
  ]);
  assert.strictEqual(unknown.summary.totalInconsistent, 0);
  assert.strictEqual(unknown.summary.totalNeedsReview, 1);
  console.log('PASS: real contradictions stay inconsistent, harmless duplicates do not');
}

// F7 (audit fixture): W-9 matches the checklist item W-9 Form
{
  const res = run([{ id: 'Harlow Trust', item: 'W-9', status: 'Uploaded', due: '', owner: 'Dana' }], ['W-9 Form']);
  assert.strictEqual(res.worklist.length, 0, JSON.stringify(res.worklist));
  assert.strictEqual(res.summary.totalGaps, 0);
  assert.strictEqual(res.cases[0].totalItemsCount, 1);
  assert.strictEqual(res.cases[0].isComplete, true);
  console.log('PASS: audit fixture, "W-9" matches checklist "W-9 Form"');
}

// F8: normalisation of case, punctuation, hyphens, form/copy suffixes and plurals
{
  const same = [
    ['W-9', 'W-9 Form'], ['w9', 'W-9 form'], ['W-9 Copy', 'W 9'], ['Form W-9', 'w-9'],
    ['Bank Statements', 'bank statement'], ['Proof-of-Address', 'proof of address'],
    ['Government Photo ID', 'government photo id.'], ['Tax Returns', 'Tax Return Copy'],
    ['Utility Bills', 'Utility Bill']
  ];
  for (const [a, b] of same) {
    assert.strictEqual(Engine.itemKey(a), Engine.itemKey(b), a + ' vs ' + b);
  }
  console.log('PASS: checklist names normalise');
}

// F9: a loose match goes to needs review and never decides silently
{
  const res = run([{ id: 'Pierce LLC', item: 'Photo ID', status: 'Uploaded', due: '', owner: 'Dana' }], ['Government Photo ID']);
  const w = wl(res, 'Government Photo ID');
  assert.ok(w, 'uncertain checklist item is on the worklist');
  assert.strictEqual(w.normStatus, 'needs_review');
  assert.strictEqual(w.entirelyMissing, false);
  assert.ok(w.reason.includes('Photo ID'), w.reason);
  assert.strictEqual(res.summary.totalGaps, 0, 'not counted as a missing item');
  assert.strictEqual(res.cases[0].isComplete, false, 'F15: not complete while a match awaits review');
  assert.strictEqual(res.reminders.length, 0, 'F12/F16: no client email for an uncertain match');
  console.log('PASS: loose match goes to needs review, never to the client');
}

// F10 + F11: absent items are still reported, different documents are not merged
{
  const res = run([{ id: 'C1', item: 'Proof of Income', status: 'Received', due: '', owner: 'A' }],
    ['Proof of Address', 'W-9 Form', 'W-8BEN']);
  const gaps = res.cases[0].missingItems.map(i => i.item).sort();
  assert.deepStrictEqual(gaps, ['Proof of Address', 'W-8BEN', 'W-9 Form']);
  assert.ok(res.worklist.every(w => w.entirelyMissing), 'absent items stay "Unrecorded"');
  assert.strictEqual(res.summary.totalNeedsReview, 0);
  assert.strictEqual(res.reminders.length, 1);
  console.log('PASS: absent items still flagged, distinct documents stay distinct');
}

// F12 + F13 + F14: client emails
{
  const rows = [
    { id: 'C1', item: 'W-9', status: 'Uploaded', due: '', owner: 'Dana' },
    { id: 'C1', item: 'Proof of Address', status: 'Missing', due: '', owner: 'Dana' },
    { id: 'C1', item: 'Bank Statement', status: 'Received', due: '', owner: 'Dana' },
    { id: 'C1', item: 'Bank Statement', status: 'Missing', due: '', owner: 'Dana' },
    { id: 'C1', item: 'Trust Deed', status: 'Waiting on counsel', due: '', owner: 'Dana' },
    { id: 'C1', item: 'Photo ID', status: 'Uploaded', due: '', owner: 'Dana' }
  ];
  const res = run(rows, ['W-9 Form', 'Proof of Address', 'Bank Statement', 'Trust Deed', 'Government Photo ID']);
  assert.strictEqual(res.reminders.length, 1);
  const r = res.reminders[0];
  assert.strictEqual(r.itemCount, 1);
  assert.strictEqual(r.itemLabel, '1 item');
  assert.ok(r.text.includes('Proof of Address'));
  for (const banned of ['W-9', 'Bank Statement', 'Trust Deed', 'Photo ID']) {
    assert.ok(!r.text.includes(banned), 'email must not ask for ' + banned + ':\n' + r.text);
  }
  assert.strictEqual(r.heldBackCount, 3);
  assert.strictEqual(Engine.pluralize(2, 'item'), '2 items');
  assert.strictEqual(Engine.pluralize(0, 'item'), '0 items');
  console.log('PASS: client emails only ask for confirmed gaps, with correct grammar');
}

// F12 end to end on the realistic wealth-advisor tracker (also the browser E2E fixture)
{
  const rows = Engine.parseCSV(fs.readFileSync(path.join(__dirname, 'fixtures', 'wealth-advisor-tracker.csv'), 'utf8'));
  const header = rows.shift();
  const data = rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  assert.strictEqual(data.length, 11);
  const res = Engine.analyzeIntake(data,
    { caseId: 'Client', requiredItem: 'Document', status: 'Status', dueDate: 'Due Date', owner: 'Advisor' },
    { referenceDate: REF, requiredItemsList: Engine.parseRequiredItemsList('Government Photo ID, Proof of Address, W-9 Form, Bank Account Details') });
  assert.strictEqual(res.summary.totalCases, 3);
  assert.strictEqual(res.summary.totalInconsistent, 0, 'zero false inconsistent alarms');
  assert.strictEqual(res.summary.totalOverdue, 1, 'only the genuinely overdue Okafor address');
  assert.deepStrictEqual(res.worklist.map(w => w.caseId + '|' + w.item + '|' + w.priority), [
    'Okafor Family|Proof of Address|Urgent',
    'Pierce LLC|Bank Account Details|Medium',
    'Pierce LLC|Government Photo ID|Review',
    'Harlow Trust|Bank Account Details|Low'
  ]);
  const email = c => res.reminders.find(r => r.caseId === c).text;
  assert.ok(email('Harlow Trust').includes('Bank Account Details') && !email('Harlow Trust').includes('W-9') && !email('Harlow Trust').includes('Proof of Address'));
  assert.ok(email('Okafor Family').includes('Proof of Address') && !email('Okafor Family').includes('W-9'));
  assert.ok(email('Pierce LLC').includes('Bank Account Details') && !email('Pierce LLC').includes('Photo ID'));
  assert.ok(res.reminders.every(r => r.itemCount === 1 && r.itemLabel === '1 item'));
  console.log('PASS: wealth-advisor tracker gives zero false alarms and correct email drafts');
}

// Failure modes found by independent review (same ticket)
//  F18 A status of only symbols or non-Latin text is read as blank and called "missing".
//  F19 "Under Review" and "Sent" still make the client get asked for something they may have handed in.
//  F20 With no status column mapped, every listed row is called missing and emailed.
//  F21 A name with no letters or digits "possibly matches" everything.
//  F22 Different documents share a key (Schedule A vs Schedule, 1-2 vs 12, non-Latin names), or
//      the same document differs only by accents or full-width characters.
//  F23 A row still marked missing sits next to a near-duplicate row that is complete, and the client is asked.
//  F24 Names like constructor or __proto__ crash the engine or pollute Object.
//  F25 An unparseable due date is printed in a client email.
//  F26 Very long names make the fuzzy comparison slow.
{
  for (const s of ['✓', '✗', '?', '已收到', '—']) {
    assert.strictEqual(Engine.normalizeStatus(s), 'needs_review', 'symbol status ' + s);
  }
  const res = run([{ id: 'C1', item: 'W-9', status: '✓', due: '', owner: 'A' }]);
  assert.strictEqual(res.reminders.length, 0);
  assert.strictEqual(res.summary.totalNeedsReview, 1);
  console.log('PASS: symbol-only statuses go to needs review');
}

{
  for (const s of ['Under Review', 'in review', 'Sent']) {
    assert.strictEqual(Engine.normalizeStatus(s), 'in_review', s);
  }
  const res = run([
    { id: 'C1', item: 'W-9', status: 'Under Review', due: '2026-10-01', owner: 'A' },
    { id: 'C1', item: 'Trust Deed', status: 'Sent', due: '2026-10-01', owner: 'A' }
  ]);
  assert.strictEqual(res.reminders.length, 0, 'never ask the client for something possibly handed in');
  assert.strictEqual(res.summary.totalOverdue, 0);
  assert.strictEqual(res.worklist.length, 2);
  assert.ok(res.worklist.every(w => w.priority === 'Low' && !w.inconsistent && !w.isOverdue));
  assert.strictEqual(res.cases[0].isComplete, false);
  assert.strictEqual(res.summary.totalHeldBack, 2);
  console.log('PASS: under review and sent are never asked of the client');
}

{
  const rows = [{ id: 'C1', item: 'W-9' }, { id: 'C1', item: 'Passport' }];
  const res = Engine.analyzeIntake(rows, { caseId: 'id', requiredItem: 'item' },
    { referenceDate: REF, requiredItemsList: ['W-9 Form', 'Passport', 'Bank Statement'] });
  assert.strictEqual(res.reminders.length, 1);
  assert.ok(res.reminders[0].text.includes('Bank Statement') && !res.reminders[0].text.includes('W-9') && !res.reminders[0].text.includes('Passport'));
  const blank = run([{ id: 'C1', item: 'W-9', status: '', due: '', owner: 'A' }]);
  assert.strictEqual(blank.summary.totalGaps, 1, 'a blank cell in a mapped status column still means nothing recorded');
  console.log('PASS: with no status column, listed rows count as received');
}

{
  const res = run([{ id: 'C1', item: '-', status: 'Received', due: '', owner: 'A' }, { id: 'C1', item: 'W-9', status: 'Received', due: '', owner: 'A' }],
    ['W-9', 'Bank Account Details', '身份证']);
  const gaps = res.cases[0].missingItems.map(i => i.item).sort();
  assert.deepStrictEqual(gaps, ['Bank Account Details', '身份证']);
  assert.strictEqual(res.summary.totalNeedsReview, 0);
  console.log('PASS: names without letters or digits never match');
}

{
  const distinct = [['Schedule A', 'Schedule'], ['Bank Statement 1-2', 'Bank Statement 12'], ['身份证 copy', '护照 copy'], ['Passport', 'Passports 2']];
  for (const [a, b] of distinct) assert.notStrictEqual(Engine.itemKey(a), Engine.itemKey(b), a + ' vs ' + b);
  const same = [['Ｗ-９ Form', 'W-9'], ["Pièce d'identité", "Piece d'identite"], ['W9', 'W-9 Copy'], ['Form 1040', 'form1040']];
  for (const [a, b] of same) assert.strictEqual(Engine.itemKey(a), Engine.itemKey(b), a + ' vs ' + b);
  const res = run([{ id: 'C1', item: '身份证 copy', status: 'Received', due: '', owner: 'A' }], ['护照 copy']);
  assert.strictEqual(res.cases[0].missingItems.length, 1);
  console.log('PASS: different documents keep different keys, same documents share one');
}

{
  const res = run([
    { id: 'C1', item: 'Photo ID', status: 'Missing', due: '', owner: 'A' },
    { id: 'C1', item: 'Government Photo ID', status: 'Received', due: '', owner: 'A' }
  ]);
  assert.strictEqual(res.reminders.length, 0);
  assert.strictEqual(wl(res, 'Photo ID').normStatus, 'needs_review');
  const withChecklist = run([
    { id: 'C1', item: 'Proof of Address', status: 'Missing', due: '', owner: 'A' },
    { id: 'C1', item: 'Proof of Address - Utility Bill', status: 'Received', due: '', owner: 'A' }
  ], ['Proof of Address']);
  assert.strictEqual(withChecklist.reminders.length, 0);
  const bothOnChecklist = run([
    { id: 'C1', item: 'Proof of Address', status: 'Missing', due: '', owner: 'A' },
    { id: 'C1', item: 'Proof of Address - Utility Bill', status: 'Received', due: '', owner: 'A' }
  ], ['Proof of Address', 'Proof of Address - Utility Bill']);
  assert.strictEqual(bothOnChecklist.reminders.length, 1, 'two distinct checklist items stay distinct');
  console.log('PASS: a missing row beside a near-duplicate complete row is not asked of the client');
}

{
  const res = run([
    { id: 'constructor', item: 'Constructor', status: 'constructor', due: '', owner: 'toString' },
    { id: '__proto__', item: '__proto__', status: 'Missing', due: '', owner: 'A' },
    { id: 'hasOwnProperty', item: 'W-9', status: 'Received', due: '', owner: 'A' }
  ], ['constructor', 'W-9 Form']);
  assert.strictEqual(res.summary.totalCases, 3);
  assert.strictEqual(({}).item, undefined, 'Object.prototype is untouched');
  assert.deepStrictEqual(Engine.parseRequiredItemsList('constructor, Constructor, toString'), ['constructor', 'toString']);
  console.log('PASS: prototype-looking names are plain data');
}

{
  const res = run([{ id: 'C1', item: 'Bank Statement', status: 'Pending', due: 'invalid-date', owner: 'A' }]);
  assert.ok(!res.reminders[0].text.includes('invalid-date'));
  assert.ok(res.reminders[0].text.includes('Bank Statement (Pending)'));
  console.log('PASS: bad due dates never reach a client email');
}

{
  const long = n => 'document ' + 'x'.repeat(n);
  const rows = [];
  for (let c = 0; c < 50; c++) for (let r = 0; r < 10; r++) rows.push({ id: 'C' + c, item: long(1000 + r), status: 'Received', due: '', owner: 'A' });
  const start = Date.now();
  run(rows, [long(1002) + 'y', long(999)]);
  assert.ok(Date.now() - start < 1500, 'long names stay fast: ' + (Date.now() - start) + 'ms');
  console.log('PASS: very long names stay fast');
}

// F17: the hosted CTA goes to the offer page with UTM tags
{
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const cta = 'https://www.nodestar.ai/installs/invoice-chase?utm_source=tool&utm_medium=lead-magnet&utm_campaign=intake-gap-finder';
  assert.ok(html.includes('href="' + cta + '"'), 'CTA must link to the Invoice Chase page with UTM tags');
  assert.ok(!/href="https:\/\/nodestar\.ai"/.test(html), 'no bare homepage link');
  console.log('PASS: CTA points to the offer page with UTM tags');
}

// C1: the emailed summary is counts only: no client names, links or odd characters
{
  const rows = Engine.parseCSV(fs.readFileSync(path.join(__dirname, 'fixtures', 'wealth-advisor-tracker.csv'), 'utf8'));
  assert.ok(rows.length > 0);
  const res = Engine.analyzeIntake(rows, { caseId: 'Client', requiredItem: 'Document', status: 'Status', dueDate: 'Due', assignee: '' });
  const text = Engine.summaryReport(res);
  assert.ok(text.startsWith('Client Intake Gap Finder\n'));
  assert.ok(/^[A-Za-z0-9 .:,\n]+$/.test(text), 'summary must be plain ASCII counts: ' + text);
  assert.ok(!/https?:|www\./i.test(text));
  const csvText = fs.readFileSync(path.join(__dirname, 'fixtures', 'wealth-advisor-tracker.csv'), 'utf8');
  for (const line of csvText.trim().split('\n').slice(1)) {
    const [client, , , , advisor] = line.split(',');
    assert.ok(!text.includes(client) && (!advisor || !text.includes(advisor)), 'client data leaked: ' + client + ' / ' + advisor);
  }
  console.log('PASS: emailed summary carries counts only');
}

// C2: the hosted page wires the shared email form and never auto-offers the demo
{
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.includes('<ns-tool-capture id="capture" tool="intake-gap-finder"'));
  assert.ok(html.includes('publishReport(usingDemo ? \'\' : IntakeGapEngine.summaryReport(analysis))'));
  assert.deepStrictEqual([...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]), ['logic.js', '/tools/capture.js']);
  console.log('PASS: email form wired, demo never offered');
}

console.log('\nAll test suites passed successfully!');
