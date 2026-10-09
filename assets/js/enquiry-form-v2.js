/*
 * Vishar Tattoo enquiry form v2: adaptive multi-step booking form.
 *
 * Shares consent, advertising handoff, attribution and idempotency with the
 * legacy form through window.VisharBooking (booking/index.html). The catalogue
 * keys below must match config/enquiry-form-v2.json on the CRM trunk; the
 * server re-validates every answer and derives the CRM's legacy fields.
 *
 * Privacy: project answers are kept in localStorage for 7 days so an
 * accidental close can resume; name and contact details are kept only in
 * sessionStorage. Images are held in memory only and are never persisted.
 */
(function () {
  'use strict';

  var shared = window.VisharBooking;
  var root = document.getElementById('enquiry-v2');
  if (!shared || !root || !shared.useV2) return;

  // ---------------------------------------------------------------------------
  // Catalogue (mirrors config/enquiry-form-v2.json)
  // ---------------------------------------------------------------------------

  var REGIONS = [
    { key: 'arm', label: 'Arm', placements: [
      ['shoulder', 'Shoulder'], ['upper_arm', 'Upper arm'], ['inner_bicep', 'Inner bicep'], ['elbow', 'Elbow'],
      ['forearm', 'Forearm'], ['wrist', 'Wrist'], ['half_sleeve', 'Half sleeve', 'arm_sleeve', true],
      ['three_quarter_sleeve', '3/4 sleeve', 'arm_sleeve', true], ['full_sleeve', 'Full sleeve', 'arm_sleeve', true],
      ['other', 'Other'] ] },
    { key: 'leg', label: 'Leg', placements: [
      ['thigh', 'Thigh'], ['knee', 'Knee'], ['calf', 'Calf'], ['shin', 'Shin'], ['ankle', 'Ankle'],
      ['half_leg_sleeve', 'Half leg sleeve', 'leg_sleeve', true], ['full_leg_sleeve', 'Full leg sleeve', 'leg_sleeve', true],
      ['other', 'Other'] ] },
    { key: 'chest_ribs', label: 'Chest & Ribs', placements: [
      ['sternum', 'Sternum'], ['one_side_chest', 'One side of chest'], ['collarbone', 'Collarbone'], ['ribs', 'Ribs'],
      ['full_chest', 'Full chest', null, true], ['other', 'Other'] ] },
    { key: 'back', label: 'Back', placements: [
      ['upper_back', 'Upper back'], ['shoulder_blade', 'Shoulder blade'], ['spine', 'Spine'], ['lower_back', 'Lower back'],
      ['full_back', 'Full back', null, true], ['other', 'Other'] ] },
    { key: 'stomach_sides', label: 'Stomach & Sides', placements: [
      ['stomach', 'Stomach'], ['side', 'Side'], ['hip', 'Hip'], ['other', 'Other'] ] },
    { key: 'neck_head', label: 'Neck & Head', placements: [
      ['front_neck', 'Front of neck'], ['side_neck', 'Side of neck'], ['back_neck', 'Back of neck'],
      ['behind_ear', 'Behind the ear'], ['head', 'Head'], ['other', 'Other'] ] },
    { key: 'hand', label: 'Hand', placements: [
      ['back_of_hand', 'Back of hand'], ['fingers', 'Fingers'], ['side_of_hand', 'Side of hand'], ['other', 'Other'] ] },
    { key: 'foot', label: 'Foot', placements: [
      ['top_of_foot', 'Top of foot'], ['side_of_foot', 'Side of foot'], ['toes', 'Toes'], ['other', 'Other'] ] },
    { key: 'other', label: 'Other', placements: [] }
  ];
  var WORK = [['new', 'No existing tattoo'], ['extension', 'Extend existing tattoo'], ['cover_up', 'Cover-up'], ['rework', 'Rework']];
  var WORK_REVIEW = { new: 'New tattoo', extension: 'Extension', cover_up: 'Cover-up', rework: 'Rework' };
  var STYLES = [['black_grey', 'Black & Grey realism'], ['colour', 'Colour realism'], ['not_sure', 'Not sure yet']];
  var DISCOVERY = [
    ['instagram', 'Instagram'], ['google', 'Google'], ['ai', 'ChatGPT / AI'], ['referral', 'Friend / Recommendation'],
    ['convention', 'Tattoo convention'], ['returning_client', 'Returning client'], ['other', 'Other']
  ];
  var DISCOVERY_DETAIL = {
    ai: { label: 'Which AI service?', required: false },
    referral: { label: 'Who recommended Vladimir?', required: false },
    other: { label: 'Where did you find Vladimir?', required: true }
  };

  var LIMITS = { otherText: 120, sizeNotes: 160, existingDetails: 1000, idea: 3500, perRole: 4, total: 6, maxBytes: 4 * 1024 * 1024, totalBytes: 12 * 1024 * 1024 };
  var DRAFT_KEY = 'vishar.enquiry.v2.draft';
  var CONTACT_KEY = 'vishar.enquiry.v2.contact';
  var DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];

  function regionByKey(key) {
    for (var i = 0; i < REGIONS.length; i += 1) if (REGIONS[i].key === key) return REGIONS[i];
    return null;
  }
  function placementMeta(region, key) {
    for (var i = 0; i < region.placements.length; i += 1) if (region.placements[i][0] === key) return region.placements[i];
    return null;
  }
  function labelOf(list, key) {
    for (var i = 0; i < list.length; i += 1) if (list[i][0] === key) return list[i][1];
    return key;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function emptyState() {
    return {
      regions: [], otherRegionText: '', placements: {}, otherPlacement: {}, work: {},
      styles: [], idea: '', sizeNotes: '', existingDetails: '',
      discovery: '', discoveryDetail: '', timing: '',
      name: '', preferredReply: '', email: '', phone: '', privacy: false
    };
  }

  var state = emptyState();
  var files = { design: [], existing: [] };
  var hadImagesBeforeReload = 0;
  var current = 'placement';
  var returnToReview = false;
  var submitting = false;
  var submitted = false; // once saved, nothing is persisted again
  var preflightState = { stage: 'none', id: '', snapshot: '' };

  function hasExistingWork() {
    return state.regions.some(function (key) {
      return (state.work[key] || []).some(function (w) { return w !== 'new'; });
    });
  }
  function regionIsLarge(key) {
    var region = regionByKey(key);
    return (state.placements[key] || []).some(function (p) { var meta = region && placementMeta(region, p); return meta && meta[3]; });
  }
  function needsDesign() {
    return state.regions.some(function (key) {
      var work = state.work[key] || [];
      return work.indexOf('new') >= 0 || work.indexOf('extension') >= 0
        || (regionIsLarge(key) && (work.indexOf('cover_up') >= 0 || work.indexOf('rework') >= 0));
    });
  }
  function needsExisting() { return hasExistingWork(); }

  // ---------------------------------------------------------------------------
  // Draft persistence (text only)
  // ---------------------------------------------------------------------------

  function storage(kind) {
    try { var s = window[kind]; var probe = '__vishar_probe'; s.setItem(probe, '1'); s.removeItem(probe); return s; } catch (e) { return null; }
  }
  var local = storage('localStorage');
  var session = storage('sessionStorage');

  function saveDraft() {
    if (submitted) return;
    var project = {
      savedAt: Date.now(), step: current,
      regions: state.regions, otherRegionText: state.otherRegionText, placements: state.placements,
      otherPlacement: state.otherPlacement, work: state.work, styles: state.styles, idea: state.idea,
      sizeNotes: state.sizeNotes, existingDetails: state.existingDetails, discovery: state.discovery,
      discoveryDetail: state.discoveryDetail, timing: state.timing,
      imageCount: files.design.length + files.existing.length
    };
    var contact = { name: state.name, preferredReply: state.preferredReply, email: state.email, phone: state.phone };
    try { if (local) local.setItem(DRAFT_KEY, JSON.stringify(project)); } catch (e) { /* quota */ }
    try { if (session) session.setItem(CONTACT_KEY, JSON.stringify(contact)); } catch (e) { /* quota */ }
  }
  var saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 250); }

  function clearDraft() {
    try { if (local) local.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
    try { if (session) session.removeItem(CONTACT_KEY); } catch (e) { /* ignore */ }
  }

  function loadDraft() {
    var restored = false;
    try {
      var raw = local && local.getItem(DRAFT_KEY);
      if (raw) {
        var draft = JSON.parse(raw);
        if (draft && Date.now() - Number(draft.savedAt || 0) < DRAFT_TTL_MS) {
          ['regions', 'styles'].forEach(function (k) { if (Array.isArray(draft[k])) state[k] = draft[k].filter(function (v) { return typeof v === 'string'; }); });
          ['placements', 'otherPlacement', 'work'].forEach(function (k) { if (draft[k] && typeof draft[k] === 'object') state[k] = draft[k]; });
          ['otherRegionText', 'idea', 'sizeNotes', 'existingDetails', 'discovery', 'discoveryDetail', 'timing'].forEach(function (k) { if (typeof draft[k] === 'string') state[k] = draft[k]; });
          state.regions = state.regions.filter(function (k) { return regionByKey(k); });
          hadImagesBeforeReload = Number(draft.imageCount) || 0;
          if (typeof draft.step === 'string' && draft.step !== 'review') current = draft.step;
          restored = state.regions.length > 0 || Boolean(state.idea);
        } else if (local) {
          local.removeItem(DRAFT_KEY);
        }
      }
      var rawContact = session && session.getItem(CONTACT_KEY);
      if (rawContact) {
        var contact = JSON.parse(rawContact);
        ['name', 'preferredReply', 'email', 'phone'].forEach(function (k) { if (contact && typeof contact[k] === 'string') state[k] = contact[k]; });
      }
    } catch (e) { /* corrupt draft: start fresh */ }
    return restored;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }

  var uid = 0;
  function choice(type, name, value, label, checked, onChange, hint) {
    uid += 1;
    var id = 'ef-' + name + '-' + uid;
    var input = el('input', { type: type, id: id, name: name, value: value, className: 'ef-choice-input' });
    input.checked = Boolean(checked);
    input.addEventListener('change', function () { onChange(input.checked, input); syncSelected(); });
    return el('label', { className: 'ef-choice' + (checked ? ' is-selected' : ''), for: id }, [input, el('span', { className: 'ef-choice-label', text: label }), hint ? el('span', { className: 'ef-choice-hint', text: hint }) : null]);
  }

  // Fallback for browsers without :has(): mirror checked state on the card.
  function syncSelected() {
    Array.prototype.forEach.call(root.querySelectorAll('.ef-choice'), function (label) {
      var input = label.querySelector('.ef-choice-input');
      label.classList.toggle('is-selected', Boolean(input && input.checked));
    });
  }

  function fieldset(legend, description, children, opts) {
    opts = opts || {};
    var legendNode = el(opts.small ? 'legend' : 'legend', { className: opts.small ? 'ef-legend-small' : 'ef-question' }, [legend]);
    var nodes = [legendNode];
    if (description) nodes.push(el('p', { className: 'ef-help', text: description }));
    var grid = el('div', { className: 'ef-choices' + (opts.columns === 1 ? ' ef-choices-1' : '') }, children);
    nodes.push(grid);
    return el('fieldset', { className: 'ef-fieldset' }, nodes);
  }

  function textField(opts) {
    uid += 1;
    var id = 'ef-' + opts.name + '-' + uid;
    var input = el(opts.multiline ? 'textarea' : 'input', {
      id: id, name: opts.name, className: 'form-field' + (opts.multiline ? ' ef-textarea' : ''),
      type: opts.multiline ? null : (opts.type || 'text'), maxlength: String(opts.max),
      autocomplete: opts.autocomplete || 'off', inputmode: opts.inputmode || null,
      placeholder: opts.placeholder || null, 'aria-describedby': opts.help ? id + '-help' : null,
      required: opts.required || null, enterkeyhint: opts.multiline ? null : 'next', autocapitalize: opts.autocapitalize || null,
      spellcheck: opts.spellcheck === false ? 'false' : null
    });
    input.value = opts.value || '';
    input.addEventListener('input', function () { opts.onInput(input.value); clearError(); saveSoon(); });
    var labelNode = el('label', { for: id, className: 'field-label' }, [opts.label, opts.required ? el('span', { className: 'required', text: ' *' }) : el('span', { className: 'ef-optional', text: ' (optional)' })]);
    return el('div', { className: 'ef-field' }, [labelNode, input, opts.help ? el('p', { id: id + '-help', className: 'ef-help', text: opts.help }) : null]);
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  var STEPS = [
    { id: 'placement', title: 'Placement', visible: function () { return true; } },
    { id: 'specific', title: 'Details', visible: function () { return state.regions.some(function (k) { return k !== 'other'; }); } },
    { id: 'existing', title: 'Existing work', visible: function () { return true; } },
    { id: 'design', title: 'Design', visible: function () { return true; } },
    { id: 'images', title: 'Images', visible: function () { return true; } },
    { id: 'discovery', title: 'Discovery', visible: function () { return true; } },
    { id: 'contact', title: 'Contact', visible: function () { return true; } },
    { id: 'review', title: 'Review', visible: function () { return true; } }
  ];
  function visibleSteps() { return STEPS.filter(function (s) { return s.visible(); }); }
  function stepIndex(id) { var steps = visibleSteps(); for (var i = 0; i < steps.length; i += 1) if (steps[i].id === id) return i; return -1; }
  function stepTitle(id) { for (var i = 0; i < STEPS.length; i += 1) if (STEPS[i].id === id) return STEPS[i].title; return ''; }

  var progressBar, sectionLabel, body, errorBox, backButton, nextButton, notice, nav;

  function buildShell() {
    root.textContent = '';
    progressBar = el('div', { className: 'ef-progress-fill' });
    var progress = el('div', { className: 'ef-progress', role: 'progressbar', 'aria-label': 'Enquiry progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [progressBar]);
    sectionLabel = el('p', { className: 'ef-section', id: 'ef-section', tabindex: '-1' });
    notice = el('div', { className: 'ef-notice', hidden: true, role: 'status' });
    body = el('div', { className: 'ef-body' });
    errorBox = el('p', { className: 'ef-error', role: 'alert', hidden: true, id: 'ef-error' });
    backButton = el('button', { type: 'button', className: 'ef-btn ef-btn-secondary', text: 'Back', onclick: goBack });
    nextButton = el('button', { type: 'submit', className: 'ef-btn ef-btn-primary', text: 'Continue' });
    nav = el('div', { className: 'ef-nav' }, [backButton, nextButton]);
    var form = el('form', { className: 'ef-form', novalidate: true, 'aria-labelledby': 'ef-section' }, [progress, sectionLabel, notice, body, errorBox, nav]);
    form.addEventListener('submit', function (event) { event.preventDefault(); goNext(); });
    root.appendChild(form);
  }

  function setProgress() {
    var steps = visibleSteps();
    var index = Math.max(0, stepIndex(current));
    var percent = Math.round(((index + 1) / steps.length) * 100);
    progressBar.style.transform = 'scaleX(' + (percent / 100) + ')';
    progressBar.parentNode.setAttribute('aria-valuenow', String(percent));
    sectionLabel.textContent = stepTitle(current);
  }

  function showError(message, focusTarget) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      try { focusTarget.focus({ preventScroll: false }); } catch (e) { focusTarget.focus(); }
    } else {
      scrollIntoViewIfNeeded(errorBox);
    }
  }
  function clearError() { errorBox.hidden = true; errorBox.textContent = ''; }

  function scrollIntoViewIfNeeded(node) {
    var rect = node.getBoundingClientRect();
    var navOffset = 72;
    if (rect.top < navOffset || rect.bottom > window.innerHeight) {
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: Math.max(0, window.pageYOffset + rect.top - navOffset - 16), behavior: reduce ? 'auto' : 'smooth' });
    }
  }

  function render(focus) {
    clearError();
    body.textContent = '';
    body.classList.remove('ef-enter');
    var renderer = RENDER[current];
    body.appendChild(renderer());
    // Restart the short enter transition without moving surrounding layout.
    void body.offsetWidth;
    body.classList.add('ef-enter');
    setProgress();
    backButton.hidden = stepIndex(current) === 0;
    nextButton.hidden = false;
    nextButton.disabled = false;
    if (current === 'review') nextButton.textContent = submitting ? 'Sending…' : 'Send enquiry';
    else nextButton.textContent = returnToReview ? 'Back to review' : 'Continue';
    nextButton.disabled = submitting;
    if (focus) {
      scrollIntoViewIfNeeded(root);
      try { sectionLabel.focus({ preventScroll: true }); } catch (e) { sectionLabel.focus(); }
    }
    saveSoon();
  }

  function goTo(id, opts) {
    current = id;
    render(!(opts && opts.noFocus));
  }

  function goNext() {
    if (submitting) return;
    var problem = VALIDATE[current]();
    if (problem) { showError(problem.message, problem.focus); return; }
    if (current === 'review') { submit(); return; }
    if (returnToReview) {
      var firstInvalid = firstInvalidStep();
      if (!firstInvalid || firstInvalid === 'review') { returnToReview = false; goTo('review'); return; }
      goTo(firstInvalid);
      return;
    }
    var steps = visibleSteps();
    var index = stepIndex(current);
    goTo(steps[Math.min(index + 1, steps.length - 1)].id);
  }

  function goBack() {
    if (submitting) return;
    var steps = visibleSteps();
    var index = stepIndex(current);
    returnToReview = false;
    if (index > 0) goTo(steps[index - 1].id);
  }

  function firstInvalidStep() {
    var steps = visibleSteps();
    for (var i = 0; i < steps.length; i += 1) {
      if (steps[i].id === 'review') return 'review';
      if (VALIDATE[steps[i].id]()) return steps[i].id;
    }
    return null;
  }

  // --- Screen 1: body areas ------------------------------------------------

  function renderPlacement() {
    var wrap = el('div');
    var choices = REGIONS.map(function (region) {
      return choice('checkbox', 'region', region.key, region.label, state.regions.indexOf(region.key) >= 0, function (checked) {
        if (checked) { if (state.regions.indexOf(region.key) < 0) state.regions.push(region.key); }
        else {
          state.regions = state.regions.filter(function (k) { return k !== region.key; });
          delete state.placements[region.key]; delete state.otherPlacement[region.key]; delete state.work[region.key];
        }
        sortRegions();
        clearError();
        var other = wrap.querySelector('[data-other-region]');
        if (other) other.hidden = state.regions.indexOf('other') < 0;
        saveSoon();
      });
    });
    wrap.appendChild(fieldset('Where would you like your tattoo?', 'Choose every area that is part of this project.', choices));
    var other = textField({ name: 'otherRegion', label: 'Where else?', max: LIMITS.otherText, value: state.otherRegionText, required: true, onInput: function (v) { state.otherRegionText = v; } });
    other.setAttribute('data-other-region', '');
    other.hidden = state.regions.indexOf('other') < 0;
    wrap.appendChild(other);
    return wrap;
  }
  function sortRegions() {
    state.regions.sort(function (a, b) { return REGIONS.indexOf(regionByKey(a)) - REGIONS.indexOf(regionByKey(b)); });
  }

  // --- Screen 2: specific placement ----------------------------------------

  function renderSpecific() {
    var wrap = el('div');
    var regions = state.regions.filter(function (k) { return k !== 'other'; });
    var multiple = regions.length > 1;
    if (!multiple) wrap.appendChild(el('h2', { className: 'ef-question', text: 'Which part of the ' + regionByKey(regions[0]).label.toLowerCase() + '?' }));
    else wrap.appendChild(el('h2', { className: 'ef-question', text: 'Which parts exactly?' }));
    var hasSleeves = regions.some(function (k) { return k === 'arm' || k === 'leg'; });
    wrap.appendChild(el('p', { className: 'ef-help', text: hasSleeves ? 'Choose all that apply. A sleeve together with a part of the same limb is treated as one project.' : 'Choose all that apply.' }));
    regions.forEach(function (key) {
      var region = regionByKey(key);
      var selected = state.placements[key] || (state.placements[key] = []);
      var group;
      var note = el('p', { className: 'ef-note', hidden: true });
      function updateNote() {
        var groups = selected.map(function (p) { var m = placementMeta(region, p); return m && m[2]; }).filter(Boolean);
        note.hidden = !(groups.length && selected.length > 1 && selected.indexOf('other') < 0 || (groups.length && selected.length > 2));
        note.textContent = 'Got it: one ' + (key === 'leg' ? 'leg sleeve' : 'sleeve') + ' that includes the other selected parts.';
        var other = group.querySelector('[data-other-placement]');
        if (other) other.hidden = selected.indexOf('other') < 0;
      }
      var choices = region.placements.map(function (p) {
        return choice('checkbox', 'placement-' + key, p[0], p[1], selected.indexOf(p[0]) >= 0, function (checked, input) {
          if (checked) {
            // Sleeve lengths in one area are alternatives, not additions.
            if (p[2]) {
              region.placements.forEach(function (q) {
                if (q[2] === p[2] && q[0] !== p[0]) {
                  var at = selected.indexOf(q[0]);
                  if (at >= 0) {
                    selected.splice(at, 1);
                    var other = group.querySelector('input[value="' + q[0] + '"]');
                    if (other) other.checked = false;
                  }
                }
              });
            }
            if (selected.indexOf(p[0]) < 0) selected.push(p[0]);
          } else {
            var at = selected.indexOf(p[0]);
            if (at >= 0) selected.splice(at, 1);
          }
          clearError(); updateNote(); saveSoon();
        });
      });
      group = fieldset(multiple ? region.label : region.label + ' placement', null, choices, { small: true });
      if (!multiple) group.querySelector('legend').className = 'ef-sr-only';
      var other = textField({ name: 'otherPlacement-' + key, label: 'Describe the placement', max: LIMITS.otherText, value: state.otherPlacement[key] || '', required: true, onInput: function (v) { state.otherPlacement[key] = v; } });
      other.setAttribute('data-other-placement', '');
      group.appendChild(other);
      group.appendChild(note);
      wrap.appendChild(group);
      updateNote();
    });
    return wrap;
  }

  // --- Screen 3: existing tattoos ------------------------------------------

  function renderExisting() {
    var wrap = el('div');
    var multiple = state.regions.length > 1;
    wrap.appendChild(el('h2', { className: 'ef-question', text: 'Is there existing tattoo work?' }));
    wrap.appendChild(el('p', { className: 'ef-help', text: multiple ? 'Answer for each area. You can choose more than one, for example a rework with an extension.' : 'You can choose more than one, for example a rework with an extension.' }));
    state.regions.forEach(function (key) {
      var region = regionByKey(key);
      var selected = state.work[key] || (state.work[key] = []);
      var group;
      var choices = WORK.map(function (w) {
        return choice('checkbox', 'work-' + key, w[0], w[1], selected.indexOf(w[0]) >= 0, function (checked) {
          if (checked) {
            // "No existing tattoo" excludes the other answers for this area.
            var exclusive = w[0] === 'new';
            for (var i = selected.length - 1; i >= 0; i -= 1) {
              if (exclusive || selected[i] === 'new') {
                var input = group.querySelector('input[value="' + selected[i] + '"]');
                if (input) input.checked = false;
                selected.splice(i, 1);
              }
            }
            selected.push(w[0]);
          } else {
            var at = selected.indexOf(w[0]);
            if (at >= 0) selected.splice(at, 1);
          }
          clearError(); saveSoon();
        });
      });
      group = fieldset(region.label === 'Other' ? (state.otherRegionText || 'Other') : region.label, null, choices, { small: true });
      if (!multiple) group.querySelector('legend').className = 'ef-sr-only';
      wrap.appendChild(group);
    });
    return wrap;
  }

  // --- Screen 4: design ----------------------------------------------------

  function renderDesign() {
    var wrap = el('div');
    var styleGroup;
    var choices = STYLES.map(function (s) {
      return choice('checkbox', 'style', s[0], s[1], state.styles.indexOf(s[0]) >= 0, function (checked) {
        if (checked) {
          var exclusive = s[0] === 'not_sure';
          state.styles = state.styles.filter(function (k) {
            var drop = exclusive || k === 'not_sure';
            if (drop) { var input = styleGroup.querySelector('input[value="' + k + '"]'); if (input) input.checked = false; }
            return !drop;
          });
          state.styles.push(s[0]);
        } else {
          state.styles = state.styles.filter(function (k) { return k !== s[0]; });
        }
        clearError(); saveSoon();
      });
    });
    styleGroup = fieldset('Style', 'Black & Grey and Colour can be combined.', choices);
    wrap.appendChild(styleGroup);
    wrap.appendChild(textField({ name: 'idea', label: 'Your tattoo idea', multiline: true, max: LIMITS.idea, value: state.idea, required: true, autocapitalize: 'sentences', placeholder: 'Subject, mood, composition and anything personal that matters.', onInput: function (v) { state.idea = v; } }));
    wrap.appendChild(textField({ name: 'sizeNotes', label: 'Exact placement and approximate size', max: LIMITS.sizeNotes, value: state.sizeNotes, placeholder: 'For example: outer forearm, about 20 cm', onInput: function (v) { state.sizeNotes = v; } }));
    if (hasExistingWork()) {
      wrap.appendChild(textField({ name: 'existingDetails', label: 'Existing tattoo details', multiline: true, max: LIMITS.existingDetails, value: state.existingDetails, placeholder: 'Age, size, how dark it is, what should change.', onInput: function (v) { state.existingDetails = v; } }));
    }
    return wrap;
  }

  // --- Screen 5: images ----------------------------------------------------

  function renderImages() {
    var wrap = el('div');
    var design = needsDesign();
    var existing = needsExisting();
    wrap.appendChild(el('h2', { className: 'ef-question', text: 'Add images' }));
    wrap.appendChild(el('p', { className: 'ef-help', text: 'JPG, PNG or WebP. Large photos are resized on your device before sending.' }));
    if (hadImagesBeforeReload && !files.design.length && !files.existing.length) {
      wrap.appendChild(el('p', { className: 'ef-note ef-note-visible', text: 'The page was reloaded, so photos need to be chosen again. Your text answers are saved.' }));
    }
    if (existing) {
      wrap.appendChild(imageSection('existing', 'Existing tattoo photos', true,
        'Add a close-up and a wider photo showing the whole area if you can.'));
    }
    wrap.appendChild(imageSection('design', existing && !design ? 'Design references' : 'Design references', design,
      design ? 'References for the subject, composition or mood.' : 'Optional inspiration for the new design.'));
    return wrap;
  }

  function imageSection(role, title, required, help) {
    uid += 1;
    var inputId = 'ef-files-' + role + '-' + uid;
    var list = el('ul', { className: 'ef-thumbs', 'aria-label': title });
    var status = el('p', { className: 'ef-help', 'aria-live': 'polite' });
    var input = el('input', { type: 'file', id: inputId, accept: 'image/jpeg,image/png,image/webp', multiple: true, className: 'ef-file-input', 'data-role': role });
    var button = el('label', { for: inputId, className: 'ef-btn ef-btn-secondary ef-add', text: 'Choose photos' });
    function refresh() {
      list.textContent = '';
      files[role].forEach(function (item, index) {
        var remove = el('button', { type: 'button', className: 'ef-thumb-remove', 'aria-label': 'Remove ' + item.file.name, text: 'Remove', onclick: function () {
          URL.revokeObjectURL(item.url);
          files[role].splice(index, 1);
          refresh(); saveSoon();
        } });
        list.appendChild(el('li', { className: 'ef-thumb' }, [el('img', { src: item.url, alt: item.file.name, width: '96', height: '96', decoding: 'async' }), remove]));
      });
      var count = files[role].length;
      status.textContent = count ? count + ' of ' + LIMITS.perRole + ' added' : (required ? 'At least one photo is needed.' : 'Optional.');
      button.hidden = count >= LIMITS.perRole;
    }
    input.addEventListener('change', function () {
      var chosen = Array.prototype.slice.call(input.files || []);
      input.value = '';
      if (!chosen.length) return;
      addFiles(role, chosen, status).then(refresh);
    });
    var section = el('section', { className: 'ef-images', 'data-image-role': role }, [
      el('h3', { className: 'ef-legend-small' }, [title, required ? el('span', { className: 'required', text: ' *' }) : el('span', { className: 'ef-optional', text: ' (optional)' })]),
      el('p', { className: 'ef-help', text: help }), list, input, button, status
    ]);
    refresh();
    return section;
  }

  function totalBytes() {
    return files.design.concat(files.existing).reduce(function (sum, item) { return sum + item.file.size; }, 0);
  }

  function addFiles(role, chosen, status) {
    clearError();
    status.textContent = 'Preparing photos…';
    var room = Math.min(LIMITS.perRole - files[role].length, LIMITS.total - files.design.length - files.existing.length);
    var problems = [];
    if (chosen.length > room) {
      problems.push(room > 0 ? 'Only ' + room + ' more photo' + (room === 1 ? '' : 's') + ' can be added here.' : 'You can send up to ' + LIMITS.total + ' photos in total.');
      chosen = chosen.slice(0, Math.max(room, 0));
    }
    return chosen.reduce(function (chain, file) {
      return chain.then(function () {
        return prepareImage(file).then(function (prepared) {
          if (totalBytes() + prepared.size > LIMITS.totalBytes) { problems.push(file.name + ' would make the upload too large.'); return; }
          files[role].push({ file: prepared, url: URL.createObjectURL(prepared) });
        }, function (error) { problems.push(error.message); });
      });
    }, Promise.resolve()).then(function () {
      if (problems.length) showError(problems.join(' '));
      saveSoon();
    });
  }

  // Resize anything large on the device: iPhone photos are often 3–6 MB and
  // the server accepts 4 MB per image within a 13 MB request.
  function prepareImage(file) {
    var maxSide = 2560;
    var type = String(file.type || '').toLowerCase();
    var known = ACCEPT.indexOf(type) >= 0;
    if (known && file.size <= 1.5 * 1024 * 1024) {
      // Small files go as they are, but only if the bytes really are the
      // claimed image type; the server applies the same check.
      return sniff(file).then(function (sniffed) {
        if (sniffed && sniffed === type) return file;
        throw new Error(file.name + ' is not a supported image. Please choose a JPG, PNG or WebP photo.');
      });
    }
    return decode(file).then(function (image) {
      var width = image.width || image.naturalWidth;
      var height = image.height || image.naturalHeight;
      if (!width || !height) throw new Error(file.name + ' could not be read as an image.');
      var scale = Math.min(1, maxSide / Math.max(width, height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (image.close) image.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error(file.name + ' could not be prepared. Please choose a JPG or PNG.')); return; }
          if (blob.size > LIMITS.maxBytes) { reject(new Error(file.name + ' is still too large after resizing.')); return; }
          var name = String(file.name || 'photo').replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.jpg';
          try { resolve(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })); }
          catch (e) { blob.name = name; resolve(blob); }
        }, 'image/jpeg', 0.85);
      });
    }, function () {
      if (known && file.size <= LIMITS.maxBytes) return file;
      throw new Error(file.name + ' is not a supported image. Please choose a JPG, PNG or WebP photo.');
    });
  }

  function sniff(file) {
    var head = file.slice(0, 12);
    var read = typeof head.arrayBuffer === 'function' ? head.arrayBuffer() : new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsArrayBuffer(head);
    });
    return read.then(function (buffer) {
      var b = new Uint8Array(buffer);
      if (b.length < 12) return '';
      if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
      return '';
    }, function () { return ''; });
  }

  function decode(file) {
    if (typeof window.createImageBitmap === 'function') {
      return window.createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return decodeWithImg(file); });
    }
    return decodeWithImg(file);
  }
  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  // --- Screen 6: discovery -------------------------------------------------

  function renderDiscovery() {
    var wrap = el('div');
    var detailWrap = el('div');
    function renderDetail() {
      detailWrap.textContent = '';
      var spec = DISCOVERY_DETAIL[state.discovery];
      if (!spec) { state.discoveryDetail = ''; return; }
      detailWrap.appendChild(textField({ name: 'discoveryDetail', label: spec.label, max: 240, value: state.discoveryDetail, required: spec.required, onInput: function (v) { state.discoveryDetail = v; } }));
    }
    var choices = DISCOVERY.map(function (d) {
      return choice('radio', 'discovery', d[0], d[1], state.discovery === d[0], function (checked) {
        if (checked) { if (state.discovery !== d[0]) state.discoveryDetail = ''; state.discovery = d[0]; renderDetail(); clearError(); saveSoon(); }
      });
    });
    wrap.appendChild(fieldset('How did you hear about me?', null, choices));
    wrap.appendChild(detailWrap);
    renderDetail();
    return wrap;
  }

  // --- Screen 7: contact ---------------------------------------------------

  function renderContact() {
    var wrap = el('div');
    var contactWrap = el('div');
    wrap.appendChild(el('h2', { className: 'ef-question', text: 'How can Vladimir reply?' }));
    wrap.appendChild(textField({ name: 'timing', label: 'When would you like to start?', max: 160, value: state.timing, placeholder: 'A month, flexible, or as soon as possible', onInput: function (v) { state.timing = v; } }));
    wrap.appendChild(textField({ name: 'name', label: 'Full name', max: 120, value: state.name, required: true, autocomplete: 'name', autocapitalize: 'words', spellcheck: false, onInput: function (v) { state.name = v; } }));
    function emailField(required) {
      return textField({ name: 'email', label: required ? 'Email' : 'Email (backup)', type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'off', spellcheck: false, max: 320, value: state.email, required: required, onInput: function (v) { state.email = v; } });
    }
    function phoneField(required) {
      return textField({ name: 'phone', label: required ? 'WhatsApp number' : 'WhatsApp (backup)', type: 'tel', inputmode: 'tel', autocomplete: 'tel', max: 80, value: state.phone, required: required, help: 'With country code, for example +44 7700 900123.', onInput: function (v) { state.phone = v; } });
    }
    function renderContactFields() {
      contactWrap.textContent = '';
      if (state.preferredReply === 'WhatsApp') { contactWrap.appendChild(phoneField(true)); contactWrap.appendChild(emailField(false)); }
      else if (state.preferredReply === 'Email') { contactWrap.appendChild(emailField(true)); contactWrap.appendChild(phoneField(false)); }
    }
    var choices = [['Email', 'Email'], ['WhatsApp', 'WhatsApp']].map(function (c) {
      return choice('radio', 'preferredReply', c[0], c[1], state.preferredReply === c[0], function (checked) {
        if (checked) { state.preferredReply = c[0]; renderContactFields(); clearError(); saveSoon(); }
      });
    });
    wrap.appendChild(fieldset('Preferred reply', null, choices, { small: true }));
    wrap.appendChild(contactWrap);
    renderContactFields();
    return wrap;
  }

  // --- Screen 8: review ----------------------------------------------------

  function summaryRow(label, value, step) {
    return el('div', { className: 'ef-summary-row' }, [
      el('dt', { text: label }),
      el('dd', null, [el('span', { className: 'ef-summary-value', text: value || '—' }),
        el('button', { type: 'button', className: 'ef-edit', text: 'Edit', 'aria-label': 'Edit ' + label.toLowerCase(), onclick: function () { returnToReview = true; goTo(step); } })])
    ]);
  }

  function areaLines() {
    return state.regions.map(function (key) {
      var region = regionByKey(key);
      var parts = (state.placements[key] || []).filter(function (p) { return p !== 'other'; }).map(function (p) { return labelOf(region.placements, p); });
      if (key === 'other' && state.otherRegionText) parts.push(state.otherRegionText.trim());
      if ((state.placements[key] || []).indexOf('other') >= 0 && state.otherPlacement[key]) parts.push(state.otherPlacement[key].trim());
      return region.label + (parts.length ? ': ' + parts.join(', ') : '');
    }).join('\n');
  }
  function workLines() {
    return state.regions.map(function (key) {
      var label = key === 'other' ? (state.otherRegionText.trim() || 'Other') : regionByKey(key).label;
      return label + ': ' + (state.work[key] || []).map(function (w) { return WORK_REVIEW[w]; }).join(', ');
    }).join('\n');
  }

  function renderReview() {
    var wrap = el('div');
    wrap.appendChild(el('h2', { className: 'ef-question', text: 'Check your enquiry' }));
    var photos = [];
    if (files.existing.length) photos.push(files.existing.length + ' existing tattoo');
    if (files.design.length) photos.push(files.design.length + ' design reference' + (files.design.length === 1 ? '' : 's'));
    var source = labelOf(DISCOVERY, state.discovery) + (state.discoveryDetail.trim() ? ' · ' + state.discoveryDetail.trim() : '');
    var contact = state.name.trim() + '\n' + (state.preferredReply === 'WhatsApp'
      ? 'WhatsApp ' + state.phone.trim() + (state.email.trim() ? '\nEmail ' + state.email.trim() : '')
      : 'Email ' + state.email.trim() + (state.phone.trim() ? '\nWhatsApp ' + state.phone.trim() : ''));
    var list = el('dl', { className: 'ef-summary' }, [
      summaryRow('Body areas', areaLines(), 'placement'),
      summaryRow('Existing work', workLines(), 'existing'),
      summaryRow('Style', state.styles.map(function (s) { return labelOf(STYLES, s); }).join(', '), 'design'),
      summaryRow('Idea', state.idea.trim(), 'design'),
      state.sizeNotes.trim() ? summaryRow('Placement and size', state.sizeNotes.trim(), 'design') : null,
      summaryRow('Photos', photos.join(', '), 'images'),
      summaryRow('Start', state.timing.trim() || 'Not specified', 'contact'),
      summaryRow('Found via', source, 'discovery'),
      summaryRow('Contact', contact, 'contact')
    ].filter(Boolean));
    wrap.appendChild(list);
    if (preflightState.messages && preflightState.messages.length) wrap.appendChild(preflightNotice());
    uid += 1;
    var consentId = 'ef-privacy-' + uid;
    var consent = el('input', { type: 'checkbox', id: consentId, className: 'consent-box ef-consent-input', name: 'privacyAcknowledged' });
    consent.checked = state.privacy;
    consent.addEventListener('change', function () { state.privacy = consent.checked; clearError(); });
    wrap.appendChild(el('label', { className: 'ef-consent', for: consentId }, [consent, el('span', null, [
      'I have read the ', el('a', { href: '/privacy/', className: 'ef-link', text: 'privacy notice' }),
      ' and understand how my details and images will be used to review and reply to this enquiry.', el('span', { className: 'required', text: ' *' })
    ])]));
    // Honeypot: never shown to people.
    var trap = el('div', { className: 'ef-trap', 'aria-hidden': 'true' }, [el('label', null, ['Leave this empty', el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', id: 'ef-website' })])]);
    wrap.appendChild(trap);
    return wrap;
  }

  function preflightNotice() {
    var box = el('div', { className: 'ef-preflight', role: 'status' }, [
      el('p', { className: 'ef-preflight-title', text: 'A little more detail would help Vladimir reply sooner:' }),
      el('ul', null, preflightState.messages.map(function (m) { return el('li', { text: String(m && m.text || '') }); })),
      el('div', { className: 'ef-preflight-actions' }, [
        el('button', { type: 'button', className: 'ef-btn ef-btn-secondary', text: 'Edit details', onclick: function () { returnToReview = true; goTo('design'); } })
      ]),
      el('p', { className: 'ef-help', text: 'Or press Send enquiry to send it as it is.' })
    ]);
    return box;
  }

  var RENDER = { placement: renderPlacement, specific: renderSpecific, existing: renderExisting, design: renderDesign, images: renderImages, discovery: renderDiscovery, contact: renderContact, review: renderReview };

  // ---------------------------------------------------------------------------
  // Validation (mirrors the server; the server remains authoritative)
  // ---------------------------------------------------------------------------

  function q(selector) { return root.querySelector(selector); }
  function problem(message, selector) { return { message: message, focus: selector ? q(selector) : null }; }
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function internationalPhone(value) {
    var phone = String(value || '').trim();
    if (!/^\+?[-0-9 ().\/]+$/.test(phone)) return '';
    var digits = phone.replace(/[^0-9]/g, '');
    if (phone.charAt(0) === '+') return /^[1-9][0-9]{6,14}$/.test(digits) ? '+' + digits : '';
    if (digits.indexOf('00') === 0) { digits = digits.slice(2); return /^[1-9][0-9]{6,14}$/.test(digits) ? '+' + digits : ''; }
    if (/^07[0-9]{9}$/.test(digits)) return '+44' + digits.slice(1);
    return '';
  }

  var VALIDATE = {
    placement: function () {
      if (!state.regions.length) return problem('Please choose at least one area.', 'input[name="region"]');
      if (state.regions.indexOf('other') >= 0 && !state.otherRegionText.trim()) return problem('Please describe where else.', 'input[name="otherRegion"]');
      return null;
    },
    specific: function () {
      for (var i = 0; i < state.regions.length; i += 1) {
        var key = state.regions[i];
        if (key === 'other') continue;
        var selected = state.placements[key] || [];
        if (!selected.length) return problem('Please choose a placement for ' + regionByKey(key).label + '.', 'input[name="placement-' + key + '"]');
        if (selected.indexOf('other') >= 0 && !(state.otherPlacement[key] || '').trim()) return problem('Please describe the placement.', 'input[name="otherPlacement-' + key + '"]');
      }
      return null;
    },
    existing: function () {
      for (var i = 0; i < state.regions.length; i += 1) {
        var key = state.regions[i];
        if (!(state.work[key] || []).length) {
          var label = key === 'other' ? 'the other area' : regionByKey(key).label;
          return problem('Please answer for ' + label + '.', 'input[name="work-' + key + '"]');
        }
      }
      return null;
    },
    design: function () {
      if (!state.styles.length) return problem('Please choose a style or Not sure yet.', 'input[name="style"]');
      if (!state.idea.trim()) return problem('Please describe your tattoo idea.', 'textarea[name="idea"]');
      return null;
    },
    images: function () {
      if (needsExisting() && !files.existing.length) return problem('Please add at least one photo of your existing tattoo.', '[data-image-role="existing"] .ef-add');
      if (needsDesign() && !files.design.length) return problem('Please add at least one design reference.', '[data-image-role="design"] .ef-add');
      if (!files.existing.length && !files.design.length) return problem('Please add at least one image.', '.ef-add');
      return null;
    },
    discovery: function () {
      if (!state.discovery) return problem('Please choose how you heard about Vladimir.', 'input[name="discovery"]');
      var spec = DISCOVERY_DETAIL[state.discovery];
      if (spec && spec.required && !state.discoveryDetail.trim()) return problem('Please tell us where you found Vladimir.', 'input[name="discoveryDetail"]');
      return null;
    },
    contact: function () {
      if (!state.name.trim()) return problem('Please enter your full name.', 'input[name="name"]');
      if (!state.preferredReply) return problem('Please choose Email or WhatsApp.', 'input[name="preferredReply"]');
      var email = state.email.trim();
      var phone = state.phone.trim();
      if (state.preferredReply === 'Email' && !EMAIL.test(email)) return problem('Please enter a valid email address.', 'input[name="email"]');
      if (state.preferredReply === 'WhatsApp') {
        if (!phone) return problem('Please enter your WhatsApp number.', 'input[name="phone"]');
        if (!internationalPhone(phone)) return problem('Please include the country code, for example +44 7700 900123.', 'input[name="phone"]');
        if (email && !EMAIL.test(email)) return problem('Please check the backup email, or leave it empty.', 'input[name="email"]');
      }
      return null;
    },
    review: function () {
      var invalid = null;
      var steps = visibleSteps();
      for (var i = 0; i < steps.length && !invalid; i += 1) if (steps[i].id !== 'review' && VALIDATE[steps[i].id]()) invalid = steps[i].id;
      if (invalid) { returnToReview = true; goTo(invalid); return { message: VALIDATE[invalid]().message }; }
      if (!state.privacy) return problem('Please confirm you have read the privacy notice.', '.ef-consent-input');
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // Payload and submission
  // ---------------------------------------------------------------------------

  function projectDetails() {
    return {
      areas: state.regions.map(function (key) {
        var area = { region: key, placements: key === 'other' ? [] : (state.placements[key] || []).slice(), work: (state.work[key] || []).slice() };
        if (key === 'other') area.otherPlacement = state.otherRegionText.trim();
        else if (area.placements.indexOf('other') >= 0) area.otherPlacement = (state.otherPlacement[key] || '').trim();
        return area;
      }),
      styles: state.styles.slice(),
      sizeNotes: state.sizeNotes.trim(),
      existingDetails: hasExistingWork() ? state.existingDetails.trim() : ''
    };
  }

  function basePayload(includeFiles) {
    var payload = new FormData();
    var context = shared.attribution();
    var fields = {
      formSchema: 'enquiry-v2',
      projectDetails: JSON.stringify(projectDetails()),
      name: state.name.trim(),
      email: state.email.trim(),
      phone: state.phone.trim(),
      preferredReply: state.preferredReply,
      timing: state.timing.trim(),
      idea: state.idea.trim(),
      discoverySource: state.discovery,
      discoverySourceDetail: DISCOVERY_DETAIL[state.discovery] ? state.discoveryDetail.trim() : '',
      website: (q('#ef-website') || {}).value || '',
      privacyAcknowledged: state.privacy ? 'true' : 'false',
      privacyNoticeVersion: shared.privacyNoticeVersion,
      source: '/booking/',
      landingPage: context.landingPage,
      referrer: context.referrer,
      utmSource: context.utmSource,
      utmMedium: context.utmMedium,
      utmCampaign: context.utmCampaign,
      utmContent: context.utmContent,
      utmTerm: context.utmTerm,
      elapsedMs: String(Date.now() - shared.startedAt)
    };
    Object.keys(fields).forEach(function (key) { payload.append(key, fields[key]); });
    var ads = shared.openAiAdsServerContext();
    if (ads) {
      payload.append('openaiAdsMeasurementConsent', 'granted');
      payload.append('openaiAdsSourceUrl', ads.sourceUrl);
      if (ads.oppref) payload.append('openaiAdsOppref', ads.oppref);
    }
    var meta = shared.metaAdsServerContext();
    if (meta) {
      payload.append('metaAdsMeasurementConsent', 'granted');
      payload.append('metaAdsSourceUrl', meta.sourceUrl);
      if (meta.fbp) payload.append('metaAdsFbp', meta.fbp);
      if (meta.fbc) payload.append('metaAdsFbc', meta.fbc);
    }
    if (includeFiles) {
      files.design.forEach(function (item) { payload.append('designReferences', item.file, item.file.name); });
      files.existing.forEach(function (item) { payload.append('existingTattooPhotos', item.file, item.file.name); });
    }
    return payload;
  }

  function preflightSnapshot() { return [state.idea.trim(), state.sizeNotes.trim(), JSON.stringify(projectDetails())].join('␟'); }

  function newUuid() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
    return '';
  }

  // Optional clarity check. Never blocks: any failure or timeout sends.
  function runPreflight(key) {
    if (!shared.preflightEnabled || !shared.endpoint || preflightState.stage === 'done') return Promise.resolve(true);
    if (preflightState.stage === 'clarified') {
      preflightState.choice = preflightSnapshot() !== preflightState.snapshot ? 'corrected' : 'send_anyway';
      preflightState.stage = 'done';
      preflightState.messages = [];
      return Promise.resolve(true);
    }
    preflightState.stage = 'done';
    preflightState.choice = 'unchanged';
    preflightState.id = preflightState.id || newUuid();
    var body = basePayload(false);
    body.append('idempotencyKey', key);
    body.append('preflight', '1');
    body.append('referenceCount', String(Math.min(files.design.length + files.existing.length, 3)));
    if (preflightState.id) body.append('preflightId', preflightState.id);
    var url;
    try { var u = new URL(shared.endpoint, window.location.href); u.searchParams.set('preflight', '1'); url = u.toString(); } catch (e) { return Promise.resolve(true); }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 2500) : null;
    return fetch(url, { method: 'POST', body: body, credentials: 'same-origin', signal: controller ? controller.signal : undefined })
      .then(function (response) { return response.ok ? response.json().catch(function () { return null; }) : null; })
      .catch(function () { return null; })
      .then(function (json) {
        if (timer) clearTimeout(timer);
        var result = json && json.ok && json.preflight ? json.preflight : null;
        if (!result) return true;
        if (typeof result.id === 'string' && result.id) preflightState.id = result.id;
        var messages = Array.isArray(result.messages) ? result.messages.slice(0, 3) : [];
        if (result.status !== 'clarify' || !messages.length) return true;
        preflightState.messages = messages;
        preflightState.snapshot = preflightSnapshot();
        preflightState.stage = 'clarified';
        return false;
      });
  }

  function send(payload, onProgress) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', shared.endpoint, true);
      xhr.responseType = 'text';
      xhr.timeout = 120000;
      if (xhr.upload && onProgress) xhr.upload.onprogress = function (event) { if (event.lengthComputable) onProgress(event.loaded / event.total); };
      xhr.onload = function () {
        var json = {};
        try { json = JSON.parse(xhr.responseText || '{}'); } catch (e) { json = {}; }
        resolve({ status: xhr.status, json: json });
      };
      xhr.onerror = function () { resolve({ status: 0, json: {} }); };
      xhr.ontimeout = function () { resolve({ status: 0, json: {} }); };
      xhr.send(payload);
    });
  }

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function setSending(text) {
    nextButton.textContent = text;
  }

  function submit() {
    if (submitting) return;
    if (!shared.endpoint) { showError('Booking is not configured on this preview. Please use the live booking page.'); return; }
    var key;
    try { key = shared.idempotencyKey(); } catch (error) { showError(error.message); return; }
    submitting = true;
    nextButton.disabled = true;
    backButton.disabled = true;
    setSending('Checking…');
    clearError();

    runPreflight(key).then(function (proceed) {
      if (!proceed) {
        submitting = false;
        backButton.disabled = false;
        render(false);
        var box = q('.ef-preflight');
        if (box) scrollIntoViewIfNeeded(box);
        return null;
      }
      var payload = basePayload(true);
      payload.append('idempotencyKey', key);
      if (preflightState.id) { payload.append('preflightId', preflightState.id); payload.append('preflightChoice', preflightState.choice || 'unchanged'); }
      setSending('Sending…');
      var attempt = 0;
      function tryOnce() {
        attempt += 1;
        return send(payload, function (fraction) { setSending('Sending ' + Math.round(fraction * 100) + '%'); }).then(function (result) {
          var transient = result.status === 0 || result.status === 502 || result.status === 503 || result.status === 504;
          // The idempotency key makes an exact retry safe: the server replays
          // an enquiry it already committed instead of creating a second one.
          if (transient && attempt < 2) { setSending('Retrying…'); return wait(1500).then(tryOnce); }
          return result;
        });
      }
      return tryOnce().then(function (result) {
        if (result.status >= 200 && result.status < 300 && result.json && result.json.ok) { succeed(key, result.json); return; }
        // A 4xx is a definitive rejection: forget the key so a corrected
        // enquiry starts fresh. Keep it for 5xx and network failures.
        if (result.status >= 400 && result.status < 500) shared.clearIdempotencyKey();
        var message = (result.json && result.json.error) || (result.status === 0
          ? 'The connection dropped. Your answers are safe. Please try again.'
          : 'The enquiry could not be sent. Please try again or email info@vishartattoo.com.');
        submitting = false;
        backButton.disabled = false;
        nextButton.disabled = false;
        nextButton.textContent = 'Try again';
        routeServerError(result.json && result.json.code, message);
      });
    }).catch(function (error) {
      submitting = false;
      backButton.disabled = false;
      nextButton.disabled = false;
      nextButton.textContent = 'Try again';
      showError((error && error.message) || 'The enquiry could not be sent. Please try again.');
    });
  }

  var CODE_STEP = {
    missing_body_area: 'placement', missing_placement: 'specific', missing_existing_work: 'existing',
    missing_style: 'design', missing_design_reference: 'images', missing_existing_tattoo_photo: 'images',
    invalid_file_count: 'images', file_too_large: 'images', invalid_file_type: 'images', unrecognised_file_content: 'images',
    request_too_large: 'images', invalid_email: 'contact', invalid_whatsapp_number: 'contact', missing_whatsapp_number: 'contact',
    missing_discovery_source_detail: 'discovery'
  };
  function routeServerError(code, message) {
    var step = CODE_STEP[code];
    if (step && step !== current && STEPS.some(function (s) { return s.id === step && s.visible(); })) {
      returnToReview = true;
      goTo(step);
    }
    showError(message);
  }

  function succeed(key, result) {
    submitted = true;
    clearTimeout(saveTimer);
    clearDraft();
    state = emptyState();
    files.design.concat(files.existing).forEach(function (item) { URL.revokeObjectURL(item.url); });
    files = { design: [], existing: [] };
    shared.onSuccess(key, result);
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  var restored = loadDraft();
  buildShell();
  if (!STEPS.some(function (s) { return s.id === current && s.visible(); })) current = 'placement';
  render(false);
  if (restored) {
    notice.hidden = false;
    notice.appendChild(el('span', { text: 'Your previous answers were restored. ' }));
    notice.appendChild(el('button', { type: 'button', className: 'ef-link-button', text: 'Start over', onclick: function () {
      clearDraft();
      // A key left by an ambiguous failure belongs to the abandoned enquiry.
      shared.clearIdempotencyKey();
      preflightState = { stage: 'none', id: '', snapshot: '' };
      state = emptyState();
      files.design.concat(files.existing).forEach(function (item) { URL.revokeObjectURL(item.url); });
      files = { design: [], existing: [] };
      hadImagesBeforeReload = 0;
      notice.hidden = true;
      returnToReview = false;
      goTo('placement');
    } }));
  }
  window.addEventListener('pagehide', saveDraft);

  // Test hook: lets automated checks read the derived requirements.
  root.visharEnquiryV2 = { needsDesign: needsDesign, needsExisting: needsExisting, state: function () { return state; } };
})();
