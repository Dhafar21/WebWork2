/* ========================================
   Recipe Scaler — Script
   Parser, scaler, unit converter, timers, animations
   All vanilla JS, no dependencies
   ======================================== */

'use strict';

/* ---------- DOM refs ---------- */
const recipeInput     = document.getElementById('recipe-input');
const servingsInput   = document.getElementById('servings-input');
const servingsMinus   = document.getElementById('servings-minus');
const servingsPlus    = document.getElementById('servings-plus');
const origServingsEl  = document.getElementById('original-servings');
const unitUS          = document.getElementById('unit-us');
const unitMetric      = document.getElementById('unit-metric');
const ingredientList  = document.getElementById('ingredient-list');
const ingredientSec   = document.getElementById('ingredients-section');
const instructionList = document.getElementById('instruction-list');
const instructionSec  = document.getElementById('instructions-section');
const timerContainer  = document.getElementById('timer-container');

/* ---------- State ---------- */
let state = {
  isMetric:       false,
  originalServes: 4,
  currentServes:  4,
  ingredients:    [],    // parsed ingredient objects
  instructions:   [],    // raw instruction lines
  timerId:        0,
  _userSetServings: false,
};

/* ---------- Known units & conversion ---------- */
const US_UNITS = new Set([
  'cup','cups','c','tablespoon','tablespoons','tbsp','tbs','t',
  'teaspoon','teaspoons','tsp','ounce','ounces','oz','pound','pounds','lb','lbs',
  'pinch','dash','stick','sticks','clove','cloves',
]);

// Canonical unit names
const UNIT_ALIAS = {
  cup:'cup', cups:'cup', c:'cup',
  tablespoon:'tbsp', tablespoons:'tbsp', tbsp:'tbsp', tbs:'tbsp', t:'tbsp',
  teaspoon:'tsp', teaspoons:'tsp', tsp:'tsp',
  ounce:'oz', ounces:'oz', oz:'oz',
  pound:'lb', pounds:'lb', lb:'lb', lbs:'lb',
  clove:'clove', cloves:'clove',
};

// US → metric conversion factors
const TO_METRIC = {
  cup:   { unit:'ml', factor:240 },
  tbsp:  { unit:'ml', factor:15 },
  tsp:   { unit:'ml', factor:5 },
  oz:    { unit:'g',  factor:28.35 },
  lb:    { unit:'g',  factor:453.6 },
};

/* ---------- Fraction utilities ---------- */
const NICE_FRACTIONS = [
  { decimal:1,     display:'1' },
  { decimal:0.75,  display:'3/4' },
  { decimal:0.67,  display:'2/3' },
  { decimal:0.6,   display:'3/5' },
  { decimal:0.5,   display:'1/2' },
  { decimal:0.4,   display:'2/5' },
  { decimal:0.33,  display:'1/3' },
  { decimal:0.25,  display:'1/4' },
  { decimal:0.2,   display:'1/5' },
  { decimal:0.17,  display:'1/6' },
  { decimal:0.13,  display:'1/8' },
  { decimal:0.1,   display:'1/10' },
];

function toNiceFraction(value) {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const whole = Math.floor(abs);
  const frac = abs - whole;

  if (frac < 0.01) return sign + Math.round(abs).toString();
  if (frac > 0.99) return sign + Math.round(abs).toString();

  // For large quantities (>=10), round to nearest whole or 0.5
  if (abs >= 10) {
    const rounded = Math.round(abs * 2) / 2;
    if (rounded % 1 === 0) return sign + rounded.toString();
    return sign + Math.floor(rounded) + ' 1/2';
  }

  // For medium quantities (>=3), round to nearest 0.5 or nice fraction
  if (abs >= 3) {
    const rounded = Math.round(abs * 2) / 2;
    const rWhole = Math.floor(rounded);
    const rFrac = rounded - rWhole;
    if (rFrac < 0.01) return sign + rWhole.toString();
    if (rFrac > 0.49) return sign + rWhole + ' 1/2';
    return sign + rWhole.toString();
  }

  // Find closest nice fraction (for small quantities)
  let best = NICE_FRACTIONS[0];
  for (const f of NICE_FRACTIONS) {
    if (Math.abs(frac - f.decimal) < Math.abs(frac - best.decimal)) {
      best = f;
    }
  }

  // Only use fraction if it's close enough (within 5%)
  if (Math.abs(frac - best.decimal) > 0.05) {
    // Fall back to 1 decimal
    const dec = frac.toFixed(1);
    return sign + (whole > 0 ? whole + ' ' : '') + dec;
  }

  if (whole === 0) return sign + best.display;
  if (best.decimal === 1) return sign + (whole + 1).toString();
  return sign + whole + ' ' + best.display;
}

function parseFraction(str) {
  str = str.trim();
  // Mixed number: "1 1/2"
  const mixed = str.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return parseInt(mixed[1],10) + parseInt(mixed[2],10)/parseInt(mixed[3],10);
  // Simple fraction: "1/2"
  const frac = str.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1],10)/parseInt(frac[2],10);
  // Decimal or integer
  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

function parseRange(str) {
  const m = str.match(/^([\d.\/\s]+?)\s*[–-]\s*([\d.\/\s]+)$/);
  if (!m) return null;
  const a = parseFraction(m[1]);
  const b = parseFraction(m[2]);
  if (a === null || b === null) return null;
  return (a + b) / 2;
}

function parseQuantityPart(str) {
  // Try range first
  const range = parseRange(str);
  if (range !== null) return { value:range, raw:str };
  // Single quantity
  const val = parseFraction(str);
  if (val !== null) return { value:val, raw:str };
  return null;
}

/* ---------- Ingredient line parser ---------- */
function parseIngredientLine(line) {
  line = line.trim();
  if (!line) return null;

  // Remove trailing punctuation that's not part of the ingredient
  // But keep things like "garlic, minced"
  let clean = line.replace(/[,;]+$/, '').trim();

  // Try to extract quantity from beginning
  // Pattern: optional quantity (numbers, fractions, decimals, ranges) followed by optional unit, then ingredient name
  const qtyMatch = clean.match(/^([\d.\/\s-]+)\s+(.+)/);
  if (!qtyMatch) {
    // No quantity — just an ingredient name or instruction-like line
    return { quantity:null, rawQty:null, unit:null, name:clean, original:line };
  }

  const qtyStr = qtyMatch[1].trim();
  const rest = qtyMatch[2].trim();

  // Check if there's a range in the quantity
  let quantity = parseQuantityPart(qtyStr);

  if (!quantity) {
    // Try the raw number approach
    const simpleNum = parseFloat(qtyStr);
    if (!isNaN(simpleNum)) {
      quantity = { value:simpleNum, raw:qtyStr };
    }
  }

  if (!quantity) {
    return { quantity:null, rawQty:null, unit:null, name:clean, original:line };
  }

  // Parse unit from the rest (first word)
  const restParts = rest.split(/\s+/);
  let unit = null;
  let nameStartIdx = 0;

  if (restParts.length > 0) {
    const firstWord = restParts[0].toLowerCase().replace(/[.,;]$/,'');
    const secondWord = restParts.length > 1 ? restParts[1].toLowerCase().replace(/[.,;]$/,'') : null;

    // Check if first word is a known unit
    if (US_UNITS.has(firstWord)) {
      unit = UNIT_ALIAS[firstWord] || firstWord;
      nameStartIdx = 1;
    }
    // Handle things like "14 oz can" → unit is "oz", skip "can"
    else if (secondWord && US_UNITS.has(secondWord)) {
      unit = UNIT_ALIAS[secondWord] || secondWord;
      nameStartIdx = 2;
    }
  }

  const name = restParts.slice(nameStartIdx).join(' ').replace(/[.,;]+$/, '').trim();

  return {
    quantity: quantity.value,
    rawQty:   quantity.raw,
    unit:     unit,
    name:     name || 'untitled',
    original: line,
  };
}

/* ---------- Recipe parser ---------- */
function parseRecipe(text) {
  const lines = text.split('\n');

  // Find blank line separator between ingredients and instructions
  let inInstructions = false;
  const ingredientLines = [];
  const instructionLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      // If we haven't found the separator yet and we've seen content
      if (!inInstructions && ingredientLines.length > 0) {
        inInstructions = true;
      }
      continue;
    }

    if (inInstructions) {
      // Check if it looks like a numbered instruction
      const clean = line.replace(/^\d+[.)]\s*/, '').trim();
      instructionLines.push(clean || line);
    } else {
      ingredientLines.push(line);
    }
  }

  // Parse ingredients
  const ingredients = ingredientLines
    .map(line => parseIngredientLine(line))
    .filter(p => p !== null);

  // Detect original servings from text
  let origServes = 4;
  for (const line of lines) {
    const srv = line.match(/(?:serves|yield|makes|servings?)\s*:?\s*(\d+)/i);
    if (srv) {
      origServes = parseInt(srv[1], 10);
      break;
    }
  }

  return { ingredients, instructions:instructionLines, originalServes:origServes };
}

/* ---------- Unit conversion ---------- */
// Ingredients stored in original US units. Convert to metric on demand.
function convertToMetric(ing) {
  if (!ing.unit || ing.scaledQty === null) return null;

  const canon = UNIT_ALIAS[ing.unit] || ing.unit;
  const conv = TO_METRIC[canon];
  if (!conv) return null;

  let qty = ing.scaledQty * conv.factor;
  let unit = conv.unit;

  // Scale up units for readability
  if (unit === 'g' && qty >= 1000) { qty /= 1000; unit = 'kg'; }
  if (unit === 'ml' && qty >= 1000) { qty /= 1000; unit = 'L'; }

  return { qty, unit };
}

function finalizeIngredient(ing, ratio, isMetric) {
  const scaledQty = ing.quantity !== null ? ing.quantity * ratio : null;

  if (isMetric) {
    const metric = convertToMetric({ ...ing, scaledQty });
    if (metric) {
      return { ...ing, displayQty: metric.qty, displayUnit: metric.unit };
    }
  }

  // Fall through: show in original unit
  return { ...ing, displayQty: scaledQty, displayUnit: ing.unit };
}

/* ---------- Render ---------- */
function render() {
  const ratio = state.originalServes > 0 ? state.currentServes / state.originalServes : 1;

  // Ingredients
  if (state.ingredients.length > 0) {
    ingredientSec.style.display = '';
    ingredientList.innerHTML = '';
    state.ingredients.forEach((ing, i) => {
      const scaled = finalizeIngredient(ing, ratio, state.isMetric);
      const li = document.createElement('li');
      li.className = 'ingredient-item';
      li.style.animationDelay = (i * 30) + 'ms';

      if (scaled.displayQty !== null) {
        const qtySpan = document.createElement('span');
        qtySpan.className = 'ingredient-qty';
        qtySpan.textContent = toNiceFraction(scaled.displayQty);

        // Animate on change
        if (scaled.displayQty !== ing._lastQty) {
          qtySpan.classList.add('animating');
          setTimeout(() => qtySpan.classList.remove('animating'), 400);
        }
        ing._lastQty = scaled.displayQty;
        li.appendChild(qtySpan);

        if (scaled.displayUnit) {
          const unitSpan = document.createElement('span');
          unitSpan.className = 'ingredient-unit';
          unitSpan.textContent = scaled.displayUnit;
          li.appendChild(unitSpan);
        }
      } else {
        const qtySpan = document.createElement('span');
        qtySpan.className = 'ingredient-qty';
        qtySpan.textContent = '';
        li.appendChild(qtySpan);
      }

      const nameSpan = document.createElement('span');
      nameSpan.className = 'ingredient-name';
      nameSpan.textContent = scaled.name;
      li.appendChild(nameSpan);

      ingredientList.appendChild(li);
    });
  } else {
    ingredientSec.style.display = 'none';
  }

  // Instructions
  if (state.instructions.length > 0) {
    instructionSec.style.display = '';
    instructionList.innerHTML = '';
    state.instructions.forEach((inst, i) => {
      const li = document.createElement('li');
      li.className = 'instruction-item';
      li.style.animationDelay = (i * 30) + 'ms';

      const textSpan = document.createElement('span');
      textSpan.className = 'instruction-text';
      textSpan.innerHTML = parseTimersInText(inst);
      li.appendChild(textSpan);
      instructionList.appendChild(li);
    });
  } else {
    instructionSec.style.display = 'none';
  }

  // Update original servings display
  if (state.originalServes && state.originalServes !== 1) {
    origServingsEl.textContent = 'original: ' + state.originalServes;
  } else {
    origServingsEl.textContent = '';
  }
}

/* ---------- Time parsing & timer buttons ---------- */
function parseTimersInText(text) {
  // Match time patterns: N minutes/min/min., N seconds/sec/sec., N hour/hours
  return text.replace(
    /(\d+(?:\.\d+)?)\s*(minutes?|mins?|min\.|seconds?|secs?|sec\.|hours?|hrs?|hr\.)\b/gi,
    (match, num, unit) => {
      const totalSeconds = convertToSeconds(parseFloat(num), unit);
      if (totalSeconds === null) return match;
      const label = match.trim();
      return `<button class="timer-btn" data-seconds="${totalSeconds}" data-label="${escapeHtml(label)}">⏱ ${label}</button>`;
    }
  );
}

function convertToSeconds(num, unit) {
  const u = unit.toLowerCase().replace(/\.$/, '');
  if (/^min/i.test(u)) return num * 60;
  if (/^sec/i.test(u)) return num;
  if (/^hour/i.test(u)) return num * 3600;
  return null;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- Timer system ---------- */
const timers = new Map();

function createTimer(seconds, label) {
  const id = ++state.timerId;
  const endTime = Date.now() + seconds * 1000;
  const timer = {
    id,
    label,
    totalSeconds: seconds,
    remaining: seconds,
    endTime,
    running: true,
    interval: null,
  };

  timers.set(id, timer);
  renderTimerChip(timer);
  startTimerTick(timer);

  return id;
}

function startTimerTick(timer) {
  timer.interval = setInterval(() => {
    const remaining = Math.max(0, (timer.endTime - Date.now()) / 1000);
    timer.remaining = remaining;
    updateTimerChip(timer);

    if (remaining <= 0) {
      clearInterval(timer.interval);
      timer.running = false;
      timerComplete(timer);
    }
  }, 100);
}

function timerComplete(timer) {
  playAlertSound();
  showTimerAlert(timer.label);
  // Remove chip after a moment
  setTimeout(() => removeTimer(timer.id, true), 1500);
}

function removeTimer(id, completed = false) {
  const timer = timers.get(id);
  if (!timer) return;

  if (timer.interval) clearInterval(timer.interval);
  timer.running = false;

  const chip = document.querySelector(`.timer-chip[data-id="${id}"]`);
  if (chip) {
    chip.classList.add('removing');
    setTimeout(() => {
      chip.remove();
      if (!document.querySelector('.timer-chip')) {
        timerContainer.innerHTML = '';
      }
    }, 300);
  }
  timers.delete(id);
}

function toggleTimer(id) {
  const timer = timers.get(id);
  if (!timer) return;

  if (timer.running) {
    // Pause
    clearInterval(timer.interval);
    timer.running = false;
  } else {
    // Resume — recalculate end time
    timer.endTime = Date.now() + timer.remaining * 1000;
    timer.running = true;
    startTimerTick(timer);
  }
  updateTimerChip(timer);
}

function renderTimerChip(timer) {
  const chip = document.createElement('div');
  chip.className = 'timer-chip';
  chip.dataset.id = timer.id;

  // SVG progress ring
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const svgNS = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '40');
  svg.setAttribute('height', '40');
  svg.classList.add('timer-progress-ring');

  const bgCircle = document.createElementNS(svgNS, 'circle');
  bgCircle.setAttribute('cx', '20');
  bgCircle.setAttribute('cy', '20');
  bgCircle.setAttribute('r', radius.toString());
  bgCircle.classList.add('bg-circle');

  const progCircle = document.createElementNS(svgNS, 'circle');
  progCircle.setAttribute('cx', '20');
  progCircle.setAttribute('cy', '20');
  progCircle.setAttribute('r', radius.toString());
  progCircle.classList.add('progress-circle');
  progCircle.style.strokeDasharray = circumference;
  progCircle.style.strokeDashoffset = '0';

  svg.appendChild(bgCircle);
  svg.appendChild(progCircle);

  // Content
  const content = document.createElement('div');
  content.className = 'timer-chip-content';

  const label = document.createElement('div');
  label.className = 'timer-chip-label';
  label.textContent = timer.label;

  const timeDisplay = document.createElement('div');
  timeDisplay.className = 'timer-chip-time';
  timeDisplay.dataset.id = timer.id;

  content.appendChild(label);
  content.appendChild(timeDisplay);

  // Controls
  const controls = document.createElement('div');
  controls.className = 'timer-chip-controls';

  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'timer-chip-btn';
  pauseBtn.innerHTML = '&#10074;&#10074;'; // pause
  pauseBtn.title = 'Pause/Resume';
  pauseBtn.addEventListener('click', () => toggleTimer(timer.id));

  const closeBtn = document.createElement('button');
  closeBtn.className = 'timer-chip-btn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Dismiss';
  closeBtn.addEventListener('click', () => removeTimer(timer.id));

  controls.appendChild(pauseBtn);
  controls.appendChild(closeBtn);

  chip.appendChild(svg);
  chip.appendChild(content);
  chip.appendChild(controls);

  // Store references
  chip._progCircle = progCircle;
  chip._circumference = circumference;
  chip._timeDisplay = timeDisplay;

  timerContainer.appendChild(chip);
  updateTimerChip(timer);
}

function updateTimerChip(timer) {
  const chip = document.querySelector(`.timer-chip[data-id="${timer.id}"]`);
  if (!chip) return;

  const progCircle = chip._progCircle;
  const timeDisplay = chip._timeDisplay;
  const circumference = chip._circumference;

  const progress = timer.totalSeconds > 0 ? 1 - (timer.remaining / timer.totalSeconds) : 1;
  const offset = circumference * (1 - progress);
  progCircle.style.strokeDashoffset = offset;

  const mins = Math.floor(timer.remaining / 60);
  const secs = Math.floor(timer.remaining % 60);
  timeDisplay.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

function showTimerAlert(label) {
  const overlay = document.createElement('div');
  overlay.className = 'timer-alert-overlay';

  const box = document.createElement('div');
  box.className = 'timer-alert-box';

  box.innerHTML = `
    <div class="timer-alert-icon">⏰</div>
    <h3>Timer Done!</h3>
    <p>${escapeHtml(label)}</p>
    <button class="timer-alert-btn">Got it</button>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  box.querySelector('.timer-alert-btn').addEventListener('click', () => {
    overlay.remove();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

/* ---------- Sound ---------- */
function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const duration = 0.5;
    const freq = 880;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch(e) {
    // Audio not available — silently skip
  }
}

/* ---------- Event handlers ---------- */
function handleInput() {
  const text = recipeInput.value.trim();
  if (!text) {
    ingredientSec.style.display = 'none';
    instructionSec.style.display = 'none';
    return;
  }

  const parsed = parseRecipe(text);
  state.ingredients = parsed.ingredients;
  state.instructions = parsed.instructions;

  // Auto-detect original servings from recipe text
  // Only on first parse or if user hasn't manually adjusted
  if (!state._userSetServings) {
    state.originalServes = parsed.originalServes;
    state.currentServes = parsed.originalServes;
    servingsInput.value = state.currentServes;
  }

  render();

  // Wire up timer buttons after render
  document.querySelectorAll('.timer-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const seconds = parseFloat(btn.dataset.seconds);
      const label = btn.dataset.label;
      if (seconds && label) {
        createTimer(seconds, label);
        btn.classList.add('active');
        setTimeout(() => btn.classList.remove('active'), 300);
      }
    });
  });
}

function updateServings() {
  state._userSetServings = true;
  let val = parseInt(servingsInput.value, 10);
  if (isNaN(val) || val < 1) val = 1;
  if (val > 999) val = 999;
  servingsInput.value = val;
  state.currentServes = val;
  render();
}

function setUnit(metric) {
  state.isMetric = metric;
  unitUS.classList.toggle('active', !metric);
  unitMetric.classList.toggle('active', metric);
  render();
}

/* ---------- Init ---------- */
function init() {
  // Set initial values
  state.originalServes = 4;
  state.currentServes = 4;
  servingsInput.value = 4;

  // Event listeners
  recipeInput.addEventListener('input', handleInput);

  servingsInput.addEventListener('change', updateServings);
  servingsInput.addEventListener('input', updateServings);

  servingsMinus.addEventListener('click', () => {
    servingsInput.value = Math.max(1, parseInt(servingsInput.value, 10) - 1);
    updateServings();
  });

  servingsPlus.addEventListener('click', () => {
    servingsInput.value = Math.min(999, parseInt(servingsInput.value, 10) + 1);
    updateServings();
  });

  unitUS.addEventListener('click', () => setUnit(false));
  unitMetric.addEventListener('click', () => setUnit(true));

  // Keyboard shortcuts for stepper
  servingsInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      servingsInput.value = Math.min(999, parseInt(servingsInput.value, 10) + 1);
      updateServings();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      servingsInput.value = Math.max(1, parseInt(servingsInput.value, 10) - 1);
      updateServings();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
