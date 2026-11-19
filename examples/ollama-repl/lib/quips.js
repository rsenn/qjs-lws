/**
 * quips: what the spinner says instead of "Thinking...", and the line
 * after a reply instead of "Cogitated for 3.2s". Nerd jokes and puns
 * from Star Trek, Monkey Island, Discworld and the Indiana Jones games,
 * grouped by what the session is doing, so the joke still tells the
 * phase.
 *
 * ```js
 * quip('waiting', 7);   // the same line for the same seed, a new one for the next
 * done(3.2);            // 'Engaged at warp 9 in 3.2s'
 * ```
 */

/** lines per phase (see repl.js phaseText()), 'thinking' when the phase is unknown */
export const QUIPS = {
  thinking: [
    'Modulating the shield harmonics',
    'Consulting the Librarian (ook)',
    'Looking behind the waterfall',
    'Asking the three important-looking pirates',
    'Rerouting power from the holodeck',
    'Feeding the Luggage',
    'Searching the Grail Diary',
    'Riding Great A\'Tuin through the void',
    'Polishing the rubber chicken with a pulley in the middle',
    'Running a level 3 diagnostic',
    'Asking Death, WHO SPEAKS IN CAPITALS',
    'Choosing wisely',
    'Making it so',
    'Bribing the Patrician with tokens',
    'Looking for the Atlantean orichalcum',
    'Scanning for tachyon particles',
    'Holding its breath for ten minutes',
    'Herding octarine-coloured thoughts',
  ],
  sending: [
    'Hailing frequencies open',
    'Beam the prompt up, Scotty',
    'Sending the clacks, overhead signal GNU',
    'Mailing a message in a grog bottle',
    'Loading the photon torpedo with words',
    'Tying a note to the Ankh-Morpork post',
  ],
  waiting: [
    'Waiting for subspace to answer',
    'The model is in the Scumm Bar, back soon',
    'Waiting at the Unseen University gate',
    'Waiting in the governor\'s mansion',
    'Waiting for Sophia to finish the séance',
    'Orbiting at standard distance',
    'Look behind you, a three-headed monkey!',
    'Waiting for the trolls to finish the bridge toll',
  ],
  headers: [
    'Incoming transmission',
    'Signal acquired, on screen',
    'Something stirs in the L-space',
    'A ghost ship is on the horizon',
    'The stone disk starts to turn',
  ],
  receiving: ['Receiving the scroll', 'Unrolling the map of Atlantis', 'Downloading from the Enterprise computer'],
  reasoning: [
    'Thinking like a Vulcan, minus the emotion',
    'Insult swordfighting with itself',
    'Calculating the odds, which are never good',
    'Pondering in the Great Hall of the Wizards',
    'Deciphering the Atlantean glyphs',
    'Holding a Socratic dialogue with a seagull',
    'Applying narrativium',
    'Mind-melding with the prompt',
  ],
  streaming: [
    'Words streaming in at warp 9',
    'Winning the spitting contest',
    'The Librarian is shelving the reply',
    'Reading the inscription as it is uncovered',
    'Transporter is materializing the answer',
    'Rincewind is running with the answer',
    'Writing it on the back of a treasure map',
  ],
  'tool-call': ['Reaching for the inventory', 'Combining items in the inventory', 'Requesting an away team'],
  tool: [
    'Using the rubber chicken on the problem',
    'The away team is on the planet',
    'Pushing the stone block in the wall',
    'Asking Igor to fetch a fresh one',
    'Engineering is on it, give them 4 hours (they need 2)',
    'Whipping the vine across the gap',
  ],
  you: ['Awaiting your orders, Captain', 'Your move, mighty pirate', 'The Patrician will see you now', 'X marks the spot: your answer'],
};

/** past tense, the line after a reply, each followed by " in 3.2s" */
export const DONE = [
  'Engaged at warp 9',
  'Made it so',
  'Beamed down',
  'Found the treasure of Mêlée Island',
  'Escaped the Unseen University',
  'Chose wisely',
  'Out-insulted the Sword Master',
  'Returned the book to L-space',
  'Recovered the Grail',
  'Docked at Starbase 1',
  'Delivered by the clacks',
  'Plundered',
  'Ook',
  'Solved the Kobayashi Maru',
  'Found the lost dialogue of Plato',
  'Came back from the Dungeon Dimensions',
];

/* a stable pick per seed, so a line does not change on every spinner frame */
const pick = (list, seed) => list[((seed % list.length) + list.length) % list.length];

/** a line for phase, seed picks it (the request number, a counter) */
export const quip = (phase, seed = Math.floor(Math.random() * 1e6)) => pick(QUIPS[phase] ?? QUIPS.thinking, seed);

/** the line after a reply: a quip and the time it took */
export const done = (secs, seed = Math.floor(Math.random() * 1e6)) => `${pick(DONE, seed)} in ${secs.toFixed(1)}s`;
