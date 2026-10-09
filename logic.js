/**
 * Client Intake Gap Finder: Core Engine
 * Zero external dependencies. Browser & Node.js compatible.
 * Processes onboarding tracker CSVs, identifies missing/overdue/unowned items,
 * and produces prioritized worklists and reminder copy.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.IntakeGapEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Standard CSV Parser supporting quotes, escaped quotes (""), commas, CRLF/LF
  function parseCSV(text) {
    if (typeof text !== 'string') return [];
    var p = '', row = [''], rows = [row], i = 0, c = '', inQuote = false;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQuote) {
        if (c === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            row[row.length - 1] += '"';
            i++;
          } else {
            inQuote = false;
          }
        } else {
          row[row.length - 1] += c;
        }
      } else {
        if (c === '"') {
          inQuote = true;
        } else if (c === ',') {
          row.push('');
        } else if (c === '\r') {
          if (i + 1 < text.length && text[i + 1] === '\n') {
            i++;
          }
          row = [''];
          rows.push(row);
        } else if (c === '\n') {
          row = [''];
          rows.push(row);
        } else {
          row[row.length - 1] += c;
        }
      }
    }
    // Trim empty trailing rows
    while (rows.length > 0) {
      var last = rows[rows.length - 1];
      var allBlank = true;
      for (var k = 0; k < last.length; k++) {
        if (last[k].trim() !== '') {
          allBlank = false;
          break;
        }
      }
      if (allBlank) {
        rows.pop();
      } else {
        break;
      }
    }
    return rows;
  }

  var STOP_WORDS = ['of', 'the', 'and', 'for'];
  var NOISE_WORDS = ['form', 'copy'];

  function singular(token) {
    if (token.length > 3 && /ies$/.test(token)) return token.slice(0, -3) + 'y';
    if (token.length > 3 && /(x|ch|sh|ss|z)es$/.test(token)) return token.slice(0, -2);
    if (token.length > 2 && /s$/.test(token) && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
    return token;
  }

  // Comparable words of an item name: accents and full-width characters folded, lower case,
  // punctuation and hyphens dropped, letters split from digits ("W9" is "W 9"), plurals folded,
  // and the filler words "form" and "copy" removed.
  function itemTokens(name) {
    var words = String(name || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/(\p{L})(?=\p{N})|(\p{N})(?=\p{L})/gu, '$1$2 ')
      .split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(singular);
    var tokens = words.filter(function (w) { return NOISE_WORDS.indexOf(w) === -1 && STOP_WORDS.indexOf(w) === -1; });
    return tokens.length > 0 ? tokens : words;
  }

  // Two names with the same key are the same document ("W-9" and "W-9 Form").
  function itemKey(name) {
    var key = itemTokens(name).join(' ');
    return key || String(name || '').trim().toLowerCase();
  }

  function editDistance(a, b) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // Names that are not the same document by key but could be: one name's words are all
  // inside the other ("Photo ID" and "Government Photo ID"), or a one-letter typo.
  // A possible match is never trusted; it goes to needs review.
  function isPossibleMatch(nameA, nameB) {
    var a = itemTokens(nameA), b = itemTokens(nameB);
    if (a.length === 0 || b.length === 0) return false;
    var small = a.length <= b.length ? a : b;
    var large = a.length <= b.length ? b : a;
    if (small.every(function (t) { return large.indexOf(t) !== -1; })) return true;
    var ka = a.join(''), kb = b.join('');
    if (Math.min(ka.length, kb.length) < 5 || Math.max(ka.length, kb.length) > 200) return false;
    return Math.abs(ka.length - kb.length) <= 1 && editDistance(ka, kb) <= 1;
  }

  function pluralize(count, noun) {
    return count + ' ' + noun + (count === 1 ? '' : 's');
  }

  // Parse required items list (can be comma-separated or newline-separated text)
  function parseRequiredItemsList(text) {
    if (!text || typeof text !== 'string') return [];
    var lines = text.split(/[\r\n,]+/);
    var items = [];
    var seen = Object.create(null);
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (trimmed && !seen[itemKey(trimmed)]) {
        seen[itemKey(trimmed)] = true;
        items.push(trimmed);
      }
    }
    return items;
  }

  // Formula injection safe sanitizer for CSV cells
  // If cell starts with =, +, -, @, \t, or \r, prepend a single quote
  function sanitizeForCSV(val) {
    if (val === null || val === undefined) return '';
    var str = String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
      return "'" + str;
    }
    return str;
  }

  // Convert array of objects/rows to RFC4180 CSV with injection safety
  function exportSafeCSV(headers, rows) {
    var out = [];
    var headerRow = headers.map(function (h) {
      return '"' + String(h).replace(/"/g, '""') + '"';
    }).join(',');
    out.push(headerRow);

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cells = [];
      for (var j = 0; j < headers.length; j++) {
        var h = headers[j];
        var val = row[h];
        if (val === null || val === undefined) val = '';
        var safeVal = sanitizeForCSV(val);
        var escaped = String(safeVal).replace(/"/g, '""');
        cells.push('"' + escaped + '"');
      }
      out.push(cells.join(','));
    }
    return out.join('\r\n');
  }

  // Safe date parser: supports YYYY-MM-DD, MM/DD/YYYY, ISO formats.
  // Avoids unexpected local timezone shifts by treating YYYY-MM-DD as calendar date.
  function parseDateSafe(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    var trimmed = dateStr.trim();
    if (!trimmed) return null;

    // YYYY-MM-DD
    var isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
    if (isoMatch) {
      var y = parseInt(isoMatch[1], 10);
      var m = parseInt(isoMatch[2], 10) - 1;
      var d = parseInt(isoMatch[3], 10);
      var dt = new Date(Date.UTC(y, m, d));
      if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d) {
        return dt;
      }
      return null;
    }

    // MM/DD/YYYY
    var usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
    if (usMatch) {
      var y2 = parseInt(usMatch[3], 10);
      var m2 = parseInt(usMatch[1], 10) - 1;
      var d2 = parseInt(usMatch[2], 10);
      var dt2 = new Date(Date.UTC(y2, m2, d2));
      if (dt2.getUTCFullYear() === y2 && dt2.getUTCMonth() === m2 && dt2.getUTCDate() === d2) {
        return dt2;
      }
      return null;
    }

    // Fallback Date.parse
    var timestamp = Date.parse(trimmed);
    if (isNaN(timestamp)) return null;
    return new Date(timestamp);
  }

  // Canonicalize status values.
  // Returns 'complete' | 'pending' | 'missing' | 'in_review' | 'needs_review'. A status we do not
  // recognise is never guessed: it goes to needs_review.
  var STATUS_BUCKETS = {
    complete: ['complete', 'completed', 'received', 'verified', 'approved', 'accepted', 'waived', 'done', 'closed',
      'uploaded', 'signed', 'submitted', 'on file', 'n a', 'na', 'not applicable'],
    pending: ['pending', 'open', 'in progress', 'requested', 'waiting', 'awaiting client'],
    // Not clearly still owed by the client ("Sent" could mean either side sent it), so never asked of them.
    in_review: ['under review', 'in review', 'reviewing', 'sent'],
    missing: ['missing', 'not started', 'unsubmitted', 'needed', 'action required', 'outstanding', 'not received', 'not uploaded', 'not provided', 'not submitted']
  };
  var STATUS_LOOKUP = Object.create(null);
  Object.keys(STATUS_BUCKETS).forEach(function (bucket) {
    STATUS_BUCKETS[bucket].forEach(function (word) { STATUS_LOOKUP[word] = bucket; });
  });

  function normalizeStatus(raw) {
    var text = String(raw || '').trim();
    if (!text) return 'missing';
    var key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return STATUS_LOOKUP[key] || 'needs_review';
  }

  var DAY_MS = 1000 * 60 * 60 * 24;

  // Decide an item's final status from every row that mentions it.
  // - any unrecognised status: the item needs review (we cannot know which row is right)
  // - recognised statuses that disagree: a real contradiction, reported as inconsistent
  function resolveItemStatus(item, caseId, validationIssues) {
    var history = item.statusHistory;
    var unrecognised = history.filter(function (h) { return h.normStatus === 'needs_review'; });
    if (unrecognised.length > 0) {
      var shown = unrecognised[0].statusRaw;
      item.normStatus = 'needs_review';
      item.needsReview = true;
      item.reviewReason = history.length > 1
        ? 'rows for this item disagree and "' + shown + '" is not a status we know, so confirm the real status'
        : '"' + shown + '" is not a status we know, so confirm the real status';
      return;
    }
    for (var h = 1; h < history.length; h++) {
      if (history[h].normStatus === history[0].normStatus) continue;
      item.hasInconsistentStatus = true;
      validationIssues.push({
        rowNumber: history[h].rowNumber,
        caseId: caseId,
        item: item.item,
        type: 'inconsistent_status',
        message: 'Duplicate item with contradictory statuses: "' + history[0].statusRaw + '" vs "' + history[h].statusRaw + '"'
      });
    }
  }

  // A row still marked open next to a near-duplicate row that is complete ("Photo ID" missing,
  // "Government Photo ID" received) may already be satisfied. Ask a person, not the client.
  // Two items that are both on the checklist are different documents by design.
  function flagPossibleDuplicates(caseRecord, checklistKeys) {
    var items = Object.keys(caseRecord.items).map(function (k) { return caseRecord.items[k]; });
    items.forEach(function (a) {
      if ((a.normStatus !== 'missing' && a.normStatus !== 'pending') || a.hasInconsistentStatus) return;
      var twin = items.filter(function (b) {
        return b !== a && b.normStatus === 'complete' &&
          !(checklistKeys[a.itemKey] && checklistKeys[b.itemKey]) && isPossibleMatch(a.item, b.item);
      })[0];
      if (!twin) return;
      a.normStatus = 'needs_review';
      a.needsReview = true;
      a.reviewReason = 'possible duplicate of "' + twin.item + '" (' + (twin.rawStatus || 'listed') + '). Confirm before asking the client';
    });
  }

  // Add every checklist item the tracker lacks to a case.
  // - same document under another spelling ("W-9" vs "W-9 Form"): adopts the checklist name
  // - a row that might be the same document: needs review, never asked of the client
  // - nothing similar: an unrecorded missing item
  function applyChecklist(caseRecord, checklist, checklistKeys) {
    var trackerKeys = Object.keys(caseRecord.items);
    var ownerNames = Object.keys(caseRecord.owners);
    var defaultOwner = ownerNames.length > 0 ? ownerNames[0] : '';

    checklist.forEach(function (req) {
      var found = caseRecord.items[req.key];
      if (found) {
        found.item = req.name;
        return;
      }
      var candidates = trackerKeys.filter(function (k) {
        return !checklistKeys[k] && isPossibleMatch(req.name, caseRecord.items[k].item);
      });
      var base = {
        item: req.name,
        itemKey: req.key,
        rawDueDate: '',
        dueDate: null,
        isDueDateInvalid: false,
        owner: defaultOwner,
        hasInconsistentStatus: false,
        statusHistory: [],
        sourceRowIndex: null
      };
      if (candidates.length > 0) {
        var names = candidates.slice(0, 3).map(function (k) {
          var c = caseRecord.items[k];
          return '"' + c.item + '" (' + (c.rawStatus || 'no status') + ')';
        }).join(', ');
        base.rawStatus = 'Unconfirmed match';
        base.normStatus = 'needs_review';
        base.needsReview = true;
        base.isUncertainMatch = true;
        base.reviewReason = 'no exact match on the checklist; possible match ' + names + '. Confirm it is the same document';
        base.isEntirelyMissingFromSource = false;
      } else {
        base.rawStatus = 'Not Recorded (Missing Row)';
        base.normStatus = 'missing';
        base.needsReview = false;
        base.isEntirelyMissingFromSource = true;
      }
      caseRecord.items[req.key] = base;
    });
  }

  // Analyze intake records against mapping and required items
  // mapping = { caseId: 'colName', requiredItem: 'colName', status: 'colName', dueDate: 'colName', owner: 'colName' }
  // options = { referenceDate: Date, requiredItemsList: string[] }
  function analyzeIntake(dataRows, mapping, options) {
    options = options || {};
    var refDate = options.referenceDate ? new Date(options.referenceDate) : new Date();
    // Use midnight UTC of reference date for clean day-difference calculations
    var refDateUTC = Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate());

    var requiredItemsList = options.requiredItemsList || [];
    var mappedCases = Object.create(null);
    var validationIssues = [];

    if (!mapping || !mapping.caseId || !mapping.requiredItem) {
      return {
        error: 'Missing required column mapping for Case ID or Required Item.',
        cases: [],
        summary: null
      };
    }

    // Step 1: Parse and group entries by case ID
    for (var i = 0; i < dataRows.length; i++) {
      var row = dataRows[i];
      var rawCaseId = row[mapping.caseId];
      var rawItem = row[mapping.requiredItem];
      var rawStatus = mapping.status ? row[mapping.status] : '';
      var rawDueDate = mapping.dueDate ? row[mapping.dueDate] : '';
      var rawOwner = mapping.owner ? row[mapping.owner] : '';

      var caseId = rawCaseId !== undefined && rawCaseId !== null ? String(rawCaseId).trim() : '';
      var item = rawItem !== undefined && rawItem !== null ? String(rawItem).trim() : '';
      var owner = rawOwner !== undefined && rawOwner !== null ? String(rawOwner).trim() : '';
      var statusRaw = rawStatus !== undefined && rawStatus !== null ? String(rawStatus).trim() : '';
      var dueDateRaw = rawDueDate !== undefined && rawDueDate !== null ? String(rawDueDate).trim() : '';

      if (!caseId) {
        validationIssues.push({
          rowNumber: i + 2, // 1-indexed header + row
          type: 'blank_case_id',
          message: 'Row has empty Case ID.'
        });
        continue;
      }

      if (!item) {
        validationIssues.push({
          rowNumber: i + 2,
          type: 'blank_item',
          message: 'Case ' + caseId + ' has blank Required Item.'
        });
        continue;
      }

      if (!mappedCases[caseId]) {
        mappedCases[caseId] = {
          caseId: caseId,
          items: Object.create(null),
          owners: Object.create(null)
        };
      }

      var parsedDueDate = parseDateSafe(dueDateRaw);
      var isDueDateInvalid = dueDateRaw !== '' && parsedDueDate === null;
      if (isDueDateInvalid) {
        validationIssues.push({
          rowNumber: i + 2,
          caseId: caseId,
          item: item,
          type: 'invalid_date',
          message: 'Unparseable due date: "' + dueDateRaw + '"'
        });
      }

      // No status column: the tracker only lists documents that arrived, so a listed row is received.
      var normStatus = mapping.status ? normalizeStatus(statusRaw) : 'complete';

      if (owner) {
        mappedCases[caseId].owners[owner] = (mappedCases[caseId].owners[owner] || 0) + 1;
      }

      var key = itemKey(item);
      var historyEntry = { statusRaw: statusRaw, normStatus: normStatus, rowNumber: i + 2 };
      var existing = mappedCases[caseId].items[key];
      if (existing) {
        existing.statusHistory.push(historyEntry);
        continue;
      }
      mappedCases[caseId].items[key] = {
        item: item,
        itemKey: key,
        rawStatus: statusRaw,
        normStatus: normStatus,
        rawDueDate: dueDateRaw,
        dueDate: parsedDueDate,
        isDueDateInvalid: isDueDateInvalid,
        owner: owner,
        hasInconsistentStatus: false,
        needsReview: false,
        reviewReason: '',
        statusHistory: [historyEntry],
        sourceRowIndex: i + 2
      };
    }

    var caseIds = Object.keys(mappedCases);
    var checklist = requiredItemsList.map(function (name) { return { name: name, key: itemKey(name) }; });
    var checklistKeys = Object.create(null);
    checklist.forEach(function (req) { checklistKeys[req.key] = true; });

    // Step 2: Settle each item's status, then add checklist items the tracker lacks.
    // An absent row must not be mistaken for a complete case, and a differently
    // spelled row must not be mistaken for an absent one.
    caseIds.forEach(function (cid) {
      var cRecord = mappedCases[cid];
      Object.keys(cRecord.items).forEach(function (k) {
        resolveItemStatus(cRecord.items[k], cid, validationIssues);
      });
      flagPossibleDuplicates(cRecord, checklistKeys);
      applyChecklist(cRecord, checklist, checklistKeys);
    });

    // Step 3: Analyze each case for gaps, overdue items, unowned items, status inconsistencies
    var processedCases = [];
    var totalOverdueCount = 0;
    var totalUnownedCount = 0;
    var totalMissingCount = 0;
    var totalInconsistentCount = 0;
    var totalNeedsReviewCount = 0;
    var totalHeldBackCount = 0;
    var completedCasesCount = 0;
    var worklistItems = [];

    for (var c2 = 0; c2 < caseIds.length; c2++) {
      var currentId = caseIds[c2];
      var currentCase = mappedCases[currentId];
      var caseItemKeys = Object.keys(currentCase.items);

      var caseMissingItems = [];
      var caseOverdueItems = [];
      var caseUnownedItems = [];
      var caseInconsistentItems = [];
      var caseReviewItems = [];
      var caseTeamItems = [];
      var casePendingItems = [];
      var caseCompletedItems = [];

      var primaryOwner = Object.keys(currentCase.owners).length > 0 ? Object.keys(currentCase.owners)[0] : 'Unassigned';

      for (var k = 0; k < caseItemKeys.length; k++) {
        var it = currentCase.items[caseItemKeys[k]];
        var isOpen = it.normStatus === 'missing' || it.normStatus === 'pending';

        // Overdue check: only items we know are still open
        var isOverdue = false;
        var daysOverdue = 0;
        if (isOpen && it.dueDate) {
          var dueUTC = Date.UTC(it.dueDate.getUTCFullYear(), it.dueDate.getUTCMonth(), it.dueDate.getUTCDate());
          if (dueUTC < refDateUTC) {
            isOverdue = true;
            daysOverdue = Math.floor((refDateUTC - dueUTC) / DAY_MS);
            totalOverdueCount++;
          }
        }

        // Unowned check
        var isUnowned = !it.owner || it.owner.trim() === '' || it.owner.toLowerCase() === 'unassigned';
        if (isUnowned && it.normStatus !== 'complete') {
          totalUnownedCount++;
        }

        if (it.hasInconsistentStatus) {
          totalInconsistentCount++;
          caseInconsistentItems.push(it);
        }

        if (it.normStatus === 'missing') {
          totalMissingCount++;
          caseMissingItems.push(it);
        } else if (it.normStatus === 'pending') {
          casePendingItems.push(it);
        } else if (it.normStatus === 'needs_review') {
          totalNeedsReviewCount++;
          caseReviewItems.push(it);
        } else if (it.normStatus === 'in_review') {
          caseTeamItems.push(it);
        } else {
          caseCompletedItems.push(it);
        }

        if (isOverdue) {
          caseOverdueItems.push(it);
        }
        if (isUnowned) {
          caseUnownedItems.push(it);
        }

        // Add to global worklist if not complete or has issues
        if (it.normStatus !== 'complete' || it.hasInconsistentStatus) {
          // Explicit priority score (rule-based, no made up revenue)
          // Urgent: overdue + missing/unowned
          // High: overdue or contradictory rows
          // Medium: missing or unowned
          // Review: a status or name match a person must confirm
          // Low: open/pending within due date
          var priority = 'Low';
          var priorityRank = 5;
          if (it.needsReview) {
            priority = 'Review';
            priorityRank = 4;
          } else if (isOverdue && (it.normStatus === 'missing' || isUnowned)) {
            priority = 'Urgent';
            priorityRank = 1;
          } else if (isOverdue || it.hasInconsistentStatus) {
            priority = 'High';
            priorityRank = 2;
          } else if (it.normStatus === 'missing' || isUnowned) {
            priority = 'Medium';
            priorityRank = 3;
          }

          worklistItems.push({
            caseId: currentId,
            item: it.item,
            status: it.rawStatus || it.normStatus,
            normStatus: it.normStatus,
            dueDate: it.rawDueDate,
            daysOverdue: daysOverdue,
            isOverdue: isOverdue,
            owner: it.owner || 'Unassigned',
            isUnowned: isUnowned,
            inconsistent: it.hasInconsistentStatus,
            needsReview: it.needsReview,
            entirelyMissing: !!it.isEntirelyMissingFromSource,
            priority: priority,
            priorityRank: priorityRank,
            reason: [
              isOverdue ? daysOverdue + 'd overdue' : null,
              it.hasInconsistentStatus ? 'inconsistent status' : null,
              it.normStatus === 'missing' ? 'missing item' : null,
              it.needsReview ? 'needs review: ' + it.reviewReason : null,
              it.normStatus === 'in_review' ? 'status "' + it.rawStatus + '" does not say the client still owes this, so no client email is drafted' : null,
              isUnowned ? 'unassigned owner' : null
            ].filter(Boolean).join('; ') || 'in progress'
          });
        }
      }

      var isCaseComplete = caseMissingItems.length === 0 &&
                           casePendingItems.length === 0 &&
                           caseReviewItems.length === 0 &&
                           caseTeamItems.length === 0 &&
                           caseInconsistentItems.length === 0 &&
                           caseItemKeys.length > 0;

      if (isCaseComplete) {
        completedCasesCount++;
      }

      // Client emails ask only for items we are sure are still outstanding. Anything that
      // needs review or whose rows contradict each other is for the team, not the client.
      var askableItems = caseMissingItems.concat(casePendingItems).filter(function (x) { return !x.hasInconsistentStatus; });
      var heldBackCount = caseItemKeys.filter(function (key) {
        var x = currentCase.items[key];
        return x.needsReview || x.hasInconsistentStatus || x.normStatus === 'in_review';
      }).length;
      totalHeldBackCount += heldBackCount;

      processedCases.push({
        caseId: currentId,
        primaryOwner: primaryOwner,
        totalItemsCount: caseItemKeys.length,
        completedCount: caseCompletedItems.length,
        missingCount: caseMissingItems.length,
        pendingCount: casePendingItems.length,
        reviewCount: caseReviewItems.length,
        inReviewCount: caseTeamItems.length,
        overdueCount: caseOverdueItems.length,
        unownedCount: caseUnownedItems.length,
        inconsistentCount: caseInconsistentItems.length,
        isComplete: isCaseComplete,
        heldBackCount: heldBackCount,
        askableItems: askableItems,
        missingItems: caseMissingItems,
        overdueItems: caseOverdueItems,
        unownedItems: caseUnownedItems,
        inconsistentItems: caseInconsistentItems,
        reviewItems: caseReviewItems,
        inReviewItems: caseTeamItems,
        pendingItems: casePendingItems,
        completedItems: caseCompletedItems
      });
    }

    // Sort worklist by priority rank, then days overdue descending, then case ID
    worklistItems.sort(function (a, b) {
      if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return a.caseId.localeCompare(b.caseId);
    });

    // Generate editable reminder drafts for cases with confirmed outstanding items
    var reminderDrafts = [];
    for (var d = 0; d < processedCases.length; d++) {
      var pc = processedCases[d];
      if (pc.askableItems.length === 0) continue;

      var neededItemsList = pc.askableItems.map(function (x) {
        if (x.normStatus === 'missing') return x.item + ' (Missing)';
        return x.item + (x.dueDate ? ' (Due: ' + x.rawDueDate + ')' : ' (Pending)');
      });

      var reminderText =
        'Subject: Action required: Onboarding documentation for Case ' + pc.caseId + '\n\n' +
        'Hi there,\n\n' +
        'We are reviewing case ' + pc.caseId + ' and need the following outstanding items to proceed:\n' +
        neededItemsList.map(function (itText) { return '  * ' + itText; }).join('\n') + '\n\n' +
        'Please upload or confirm these at your earliest convenience so we can keep onboarding on schedule.\n\n' +
        'Thank you,\n' +
        (pc.primaryOwner !== 'Unassigned' ? pc.primaryOwner : 'Onboarding Operations Team');

      reminderDrafts.push({
        caseId: pc.caseId,
        owner: pc.primaryOwner,
        itemCount: neededItemsList.length,
        itemLabel: pluralize(neededItemsList.length, 'item'),
        heldBackCount: pc.heldBackCount,
        hasOverdue: pc.overdueCount > 0,
        text: reminderText
      });
    }

    return {
      cases: processedCases,
      worklist: worklistItems,
      reminders: reminderDrafts,
      validationIssues: validationIssues,
      summary: {
        totalCases: processedCases.length,
        completedCases: completedCasesCount,
        openCases: processedCases.length - completedCasesCount,
        totalGaps: totalMissingCount,
        totalOverdue: totalOverdueCount,
        totalUnowned: totalUnownedCount,
        totalInconsistent: totalInconsistentCount,
        totalNeedsReview: totalNeedsReviewCount,
        totalHeldBack: totalHeldBackCount,
        referenceDate: refDate.toISOString().split('T')[0]
      }
    };
  }

  /* Counts only, plain ASCII, no client names: the text the optional "email me
   * this report" form shows and sends. */
  function summaryReport(analysis) {
    var m = analysis.summary;
    var lines = [
      'Client Intake Gap Finder',
      'Cases checked: ' + m.totalCases + '. Complete: ' + m.completedCases + '. Still open: ' + m.openCases + '.',
      'Required items missing or not recorded: ' + m.totalGaps + '.',
      'Overdue: ' + m.totalOverdue + '. No owner assigned: ' + m.totalUnowned + '.',
      'Contradictory statuses: ' + m.totalInconsistent + '. Needs a human look: ' + m.totalNeedsReview + '.'
    ];
    return lines.join('\n');
  }

  return {
    summaryReport: summaryReport,
    parseCSV: parseCSV,
    parseRequiredItemsList: parseRequiredItemsList,
    parseDateSafe: parseDateSafe,
    normalizeStatus: normalizeStatus,
    itemKey: itemKey,
    pluralize: pluralize,
    sanitizeForCSV: sanitizeForCSV,
    exportSafeCSV: exportSafeCSV,
    analyzeIntake: analyzeIntake
  };
});
