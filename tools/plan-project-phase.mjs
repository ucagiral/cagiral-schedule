#!/usr/bin/env node
/**
 * Generate calendar events from a project phase breakdown.
 *
 * Usage: node tools/plan-project-phase.mjs <projectName> <phaseNumber>
 *
 * Reads projects.md to find the project and phase, then generates realistic
 * calendar events based on the sub-steps and estimated durations.
 */

import { readFileSync } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const projectsFile = path.join(ROOT, 'projects.md');
const durationsFile = path.join(ROOT, 'protocols', 'durations.md');

// Parse durations table from durations.md
function parseDurations() {
  try {
    const content = readFileSync(durationsFile, 'utf8');
    const lines = content.split('\n');
    const procedures = {};
    let inTable = false;

    for (const line of lines) {
      if (line.includes('| Procedure |')) inTable = true;
      if (!inTable || !line.startsWith('|')) continue;
      if (line.includes('---')) continue;

      const parts = line.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length < 3) continue;

      const name = parts[0];
      const total = parts[1];
      const hands = parts[2];

      // Parse "30–45 min" or "~2h" format
      const extractMin = (s) => {
        const num = s.match(/\d+/);
        return num ? parseInt(num[0]) : 45;
      };

      procedures[name.toLowerCase()] = {
        total: extractMin(total),
        handsOn: hands.toLowerCase().includes('all') ? 100 :
                 hands.match(/\d+/) ? parseInt(hands.match(/\d+/)[0]) : 15
      };
    }
    return procedures;
  } catch(e) {
    return {};
  }
}

// Parse projects.md to find a project and phase
function parseProject(name, phaseNum) {
  const content = readFileSync(projectsFile, 'utf8');
  const lines = content.split('\n');
  let inProject = false;
  let phaseCount = 0;
  let currentPhase = null;
  let phaseTitle = '';
  let substeps = [];
  let duration = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of project
    if (line.startsWith('## ') && line.includes(name)) {
      inProject = true;
      continue;
    }

    // End of project (another ## or EOF)
    if (inProject && line.startsWith('## ') && !line.includes(name)) {
      if (currentPhase === phaseNum) break;
      inProject = false;
    }

    if (!inProject) continue;

    // Phase header
    if (line.startsWith('### Phase ')) {
      phaseCount++;
      if (phaseCount === phaseNum) {
        phaseTitle = line.replace('### Phase ', '').trim();
        currentPhase = phaseNum;
      }
      if (phaseCount > phaseNum) break;
      continue;
    }

    if (currentPhase !== phaseNum) continue;

    // Sub-steps (lines starting with -)
    if (line.match(/^\s*-\s+/)) {
      const step = line.replace(/^\s*-\s+/, '').trim();
      if (step) substeps.push(step);
    }

    // Duration estimate
    if (line.includes('Duration estimate:')) {
      duration = line.replace('Duration estimate:', '').trim();
    }
  }

  return currentPhase === phaseNum ? { phaseTitle, substeps, duration } : null;
}

// Generate realistic calendar events from substeps
function generateEvents(projectName, phaseNum, phaseInfo, startDate) {
  const procedures = parseDurations();
  const events = [];

  const getEventDate = (idx, startDate) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + Math.floor(idx / 2)); // ~2 events per day
    return d.toISOString().split('T')[0];
  };

  const DEFAULT_DURATION = 120; // 2 hours
  const DEFAULT_ACTIVE_MIN = 60; // 1 hour hands-on

  phaseInfo.substeps.forEach((step, idx) => {
    // Try to find this step in durations
    const stepLower = step.toLowerCase();
    let duration = DEFAULT_DURATION;
    let handsOn = DEFAULT_ACTIVE_MIN;
    let type = 'active';

    for (const [proc, dur] of Object.entries(procedures)) {
      if (stepLower.includes(proc)) {
        duration = dur.total;
        handsOn = dur.handsOn;
        type = handsOn === 100 ? 'active' : (handsOn === 0 ? 'passive' : 'active');
        break;
      }
    }

    const eventDate = getEventDate(idx, startDate);
    const startHour = 9 + (idx % 4); // Spread across morning/afternoon
    const startTime = String(startHour).padStart(2, '0') + ':00';
    const endMin = (startHour * 60 + duration) % 1440;
    const endHour = Math.floor(endMin / 60);
    const endMinRem = endMin % 60;
    const endTime = String(endHour).padStart(2, '0') + ':' +
                   String(endMinRem).padStart(2, '0');

    events.push({
      id: `proj-${projectName.toLowerCase().replace(/\s+/g, '-')}-${phaseNum}-${idx}`,
      date: eventDate,
      start: startTime,
      end: endTime,
      title: step,
      category: 'experiment',
      type: type,
      status: 'pending',
      group: projectName,
      project: projectName,
      phase: phaseNum,
      notes: `Phase ${phaseNum}: ${phaseInfo.phaseTitle}`
    });
  });

  return events;
}

// Main
const projectName = process.argv[2];
const phaseNum = parseInt(process.argv[3]) || 1;
const startDate = process.argv[4] || new Date().toISOString().split('T')[0];

if (!projectName) {
  console.error('Usage: node plan-project-phase.mjs <projectName> [phaseNumber] [startDate]');
  process.exit(1);
}

try {
  const phaseInfo = parseProject(projectName, phaseNum);
  if (!phaseInfo) {
    console.error(`Project "${projectName}" phase ${phaseNum} not found in projects.md`);
    process.exit(1);
  }

  const events = generateEvents(projectName, phaseNum, phaseInfo, startDate);
  console.log(JSON.stringify(events, null, 2));
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
