// ─── State ────────────────────────────────────────────────────────────────────
let currentPokemon = null;
let team = [];
let savedTeams = [];

// ─── Utility ──────────────────────────────────────────────────────────────────
// Escapes characters that are meaningful in HTML so they render as plain text
// rather than being interpreted as markup. & must go first to avoid
// double-encoding the replacements that follow.
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Holds the most recent recommendation pools so the compare picker and
// refresh button can reference them without going through window.
let lastRecPools = null;

// ─── localStorage persistence ─────────────────────────────────────────────────
const STORAGE_KEY = 'pokemonTeamBuilder_savedTeams';

function persistSavedTeams() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTeams));
    } catch(e) {
        console.warn('Could not save to localStorage:', e);
    }
}

function loadPersistedTeams() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) savedTeams = parsed;
    } catch(e) {
        console.warn('Could not read from localStorage:', e);
    }
}
let allPokemon = [];
let showShiny = false;
let showAnimated = false;
let compareA = null;
let compareB = null;
let currentComparePicker = null; // 'a' or 'b'
const MAX_TEAM_SIZE = 6;

// ─── Generation ranges ────────────────────────────────────────────────────────
const genRanges = {
    '1': [1,151], '2': [152,251], '3': [252,386], '4': [387,493],
    '5': [494,649], '6': [650,721], '7': [722,809], '8': [810,905], '9': [906,99999],
};

// ─── Type colours ─────────────────────────────────────────────────────────────
const typeColours = {
    normal:"#A8A878", fire:"#F08030", water:"#6890F0", grass:"#78C850",
    electric:"#F8D030", ice:"#98D8D8", fighting:"#C03028", poison:"#A040A0",
    ground:"#E0C068", flying:"#A890F0", psychic:"#F85888", bug:"#A8B820",
    rock:"#B8A038", ghost:"#705898", dragon:"#7038F8", dark:"#705848",
    steel:"#B8B8D0", fairy:"#EE99AC",
};

// ─── Full defensive type chart ────────────────────────────────────────────────
// For each defending type: which attacking types are super effective (2x),
// not very effective (0.5x), or have no effect (0x).
// Dual-type Pokémon multiply these together, so Water/Ice vs Fire = 0.5 × 2 = 1x (neutral).
const typeChart = {
    normal:   { weak:['fighting'],                              resist:[],                                               immune:['ghost'] },
    fire:     { weak:['water','ground','rock'],                 resist:['fire','grass','ice','bug','steel','fairy'],      immune:[] },
    water:    { weak:['electric','grass'],                      resist:['fire','water','ice','steel'],                   immune:[] },
    grass:    { weak:['fire','ice','poison','flying','bug'],    resist:['water','electric','grass','ground'],            immune:[] },
    electric: { weak:['ground'],                               resist:['electric','flying','steel'],                    immune:[] },
    ice:      { weak:['fire','fighting','rock','steel'],        resist:['ice'],                                          immune:[] },
    fighting: { weak:['flying','psychic','fairy'],             resist:['bug','rock','dark'],                            immune:[] },
    poison:   { weak:['ground','psychic'],                     resist:['grass','fighting','poison','bug','fairy'],       immune:[] },
    ground:   { weak:['water','grass','ice'],                  resist:['poison','rock'],                                immune:['electric'] },
    flying:   { weak:['electric','ice','rock'],                resist:['grass','fighting','bug'],                       immune:['ground'] },
    psychic:  { weak:['bug','ghost','dark'],                   resist:['fighting','psychic'],                           immune:[] },
    bug:      { weak:['fire','flying','rock'],                 resist:['grass','fighting','ground'],                    immune:[] },
    rock:     { weak:['water','grass','fighting','ground','steel'], resist:['normal','fire','poison','flying'],          immune:[] },
    ghost:    { weak:['ghost','dark'],                         resist:['poison','bug'],                                 immune:['normal','fighting'] },
    dragon:   { weak:['ice','dragon','fairy'],                 resist:['fire','water','electric','grass'],              immune:[] },
    dark:     { weak:['fighting','bug','fairy'],               resist:['ghost','dark'],                                 immune:['psychic'] },
    steel:    { weak:['fire','fighting','ground'],             resist:['normal','grass','ice','flying','psychic','bug','rock','dragon','steel','fairy'], immune:['poison'] },
    fairy:    { weak:['poison','steel'],                       resist:['fighting','bug','dark'],                        immune:['dragon'] },
};

// Offensive: what types each type is super effective against (used for recommendations)
const typeStrengths = {
    normal:[], fire:["grass","ice","bug","steel"], water:["fire","ground","rock"],
    grass:["water","ground","rock"], electric:["water","flying"],
    ice:["grass","ground","flying","dragon"], fighting:["normal","ice","rock","dark","steel"],
    poison:["grass","fairy"], ground:["fire","electric","poison","rock","steel"],
    flying:["grass","fighting","bug"], psychic:["fighting","poison"],
    bug:["grass","psychic","dark"], rock:["fire","ice","flying","bug"],
    ghost:["psychic","ghost"], dragon:["dragon"], dark:["psychic","ghost"],
    steel:["ice","rock","fairy"], fairy:["fighting","dragon","dark"],
};

// ─── Dual-type aware weakness calculator ─────────────────────────────────────
// Returns { attackingType: multiplier } for a single Pokémon.
// Multiplier >= 2 means actually weak; 0 means immune; <= 0.5 means resistant.
function getPokemonWeaknessMultipliers(pokemon) {
    const defTypes = pokemon.types.map(t => t.type.name);
    const result = {};
    Object.keys(typeChart).forEach(attacker => {
        let mult = 1;
        defTypes.forEach(defender => {
            const chart = typeChart[defender];
            if (chart.immune.includes(attacker))  mult *= 0;
            else if (chart.weak.includes(attacker))   mult *= 2;
            else if (chart.resist.includes(attacker)) mult *= 0.5;
        });
        result[attacker] = mult;
    });
    return result;
}

// Returns { attackingType: numberOfTeamMembersWeakToIt } for the whole team.
// Only counts a Pokémon as weak if its net multiplier >= 2 (true weakness after dual-type calc).
function getTeamWeaknessCounts(team) {
    const counts = {};
    team.forEach(pokemon => {
        const mults = getPokemonWeaknessMultipliers(pokemon);
        Object.entries(mults).forEach(([attacker, mult]) => {
            if (mult >= 2) counts[attacker] = (counts[attacker] || 0) + 1;
        });
    });
    return counts;
}

const typeReps = {
    fire:["charizard","arcanine","blaziken","typhlosion","infernape"],
    water:["blastoise","vaporeon","swampert","gyarados","starmie"],
    grass:["venusaur","sceptile","leafeon","roserade","tangrowth"],
    electric:["raichu","jolteon","ampharos","luxray","electivire"],
    ice:["lapras","articuno","mamoswine","glaceon","weavile"],
    fighting:["lucario","machamp","heracross","infernape","conkeldurr"],
    poison:["gengar","nidoking","toxicroak","weezing","drapion"],
    ground:["garchomp","hippowdon","donphan","rhyperior","gliscor"],
    flying:["togekiss","staraptor","aerodactyl","gliscor","skarmory"],
    psychic:["alakazam","espeon","gardevoir","metagross","gallade"],
    bug:["scizor","heracross","yanmega","forretress","volcarona"],
    rock:["tyranitar","aerodactyl","rampardos","golem","rhyperior"],
    ghost:["gengar","mismagius","chandelure","dusknoir","jellicent"],
    dragon:["dragonite","salamence","garchomp","flygon","haxorus"],
    dark:["umbreon","weavile","houndoom","absol","bisharp"],
    steel:["metagross","scizor","steelix","skarmory","lucario"],
    fairy:["togekiss","gardevoir","sylveon","clefable","azumarill"],
    normal:["snorlax","blissey","porygon-z","ambipom","staraptor"],
};

// Cache for full API-fetched type rosters (fetched once per session per type)
const typePoolCache = {};

const statNames = ["HP","Atk","Def","SpAtk","SpDef","Speed"];
const statMax   = [255, 190, 230, 194, 230, 200]; // rough max per stat for bar scaling

// ─── Sprite helpers ───────────────────────────────────────────────────────────
function getSprite(data) {
    if (showAnimated) {
        const animated = data.sprites?.versions?.['generation-v']?.['black-white']?.animated;
        const src = showShiny ? animated?.front_shiny : animated?.front_default;
        if (src) return src;
    }
    return getBestSprite(data, showShiny);
}

function staticSprite(id) {
    return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;
}

// Returns the best available sprite from a pokemon data object.
// Falls back through: front_default → official artwork → static URL by id.
function getBestSprite(data, shiny) {
    if (shiny) {
        return data.sprites?.front_shiny || data.sprites?.front_default
            || data.sprites?.other?.['official-artwork']?.front_default
            || staticSprite(data.id);
    }
    return data.sprites?.front_default
        || data.sprites?.other?.['official-artwork']?.front_default
        || staticSprite(data.id);
}

// ─── Dark mode ────────────────────────────────────────────────────────────────
const darkToggle = document.getElementById('dark-mode-toggle');
let darkMode = localStorage.getItem('pokemonTeamBuilder_darkMode') === 'true';

// Apply persisted preference immediately
document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
darkToggle.textContent = darkMode ? '☀️' : '🌙';

darkToggle.addEventListener('click', () => {
    darkMode = !darkMode;
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    darkToggle.textContent = darkMode ? '☀️' : '🌙';
    localStorage.setItem('pokemonTeamBuilder_darkMode', darkMode);
});

// ─── Load all Pokémon names ───────────────────────────────────────────────────
async function loadAllPokemonNames() {
    try {
        const res = await fetch('https://pokeapi.co/api/v2/pokemon?limit=2000');
        const data = await res.json();
        allPokemon = data.results.map(p => {
            const parts = p.url.split('/').filter(Boolean);
            const id = parseInt(parts[parts.length - 1]);
            return { name: p.name, id };
        });
    } catch(e) { console.warn('Could not load Pokémon list.'); }
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────
const searchInput  = document.getElementById('pokemon-search');
const dropdown     = document.getElementById('suggestions-dropdown');
const genFilter    = document.getElementById('gen-filter');
const typeFilter   = document.getElementById('type-filter');

searchInput.addEventListener('input', () => { clearSearchError(); updateDropdown(); });
genFilter.addEventListener('change', updateDropdown);
typeFilter.addEventListener('change', updateDropdown);

function getFilteredPool() {
    let pool = allPokemon;
    const gen = genFilter.value;
    if (gen !== 'all') {
        const [min, max] = genRanges[gen];
        pool = pool.filter(p => p.id >= min && p.id <= max);
    }
    // Type filter: if set, we can only filter by name/id here since we don't have
    // type data in allPokemon. We handle it post-search in updateDropdown instead.
    return pool;
}

async function updateDropdown() {
    const query = searchInput.value.trim().toLowerCase();
    dropdown.innerHTML = '';

    const typeVal = typeFilter.value;

    // If a type is selected but no query, show popular Pokémon of that type
    if (!query && typeVal !== 'all') {
        const reps = typeReps[typeVal] || [];
        if (reps.length === 0) { dropdown.classList.remove('visible'); return; }
        reps.slice(0,8).forEach(name => {
            const match = allPokemon.find(p => p.name === name);
            if (!match) return;
            const item = createSuggestionItem(match.name, match.id, '');
            dropdown.appendChild(item);
        });
        dropdown.classList.add('visible');
        return;
    }

    if (!query || query.length < 2 || allPokemon.length === 0) {
        dropdown.classList.remove('visible');
        return;
    }

    const pool = getFilteredPool();
    const startsWith = pool.filter(p => p.name.startsWith(query));
    const contains   = pool.filter(p => !p.name.startsWith(query) && p.name.includes(query));
    let matches = [...startsWith, ...contains].slice(0, 20);

    // If type filter is active, we need to further filter by fetching type
    // For performance, we just show unfiltered and add a hint
    matches = matches.slice(0, 8);

    if (matches.length === 0) { dropdown.classList.remove('visible'); return; }

    matches.forEach(({ name, id }) => {
        dropdown.appendChild(createSuggestionItem(name, id, query));
    });

    dropdown.classList.add('visible');
}

function createSuggestionItem(name, id, query) {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const highlighted = query
        ? name.replace(new RegExp(`(${escapedQuery})`, 'i'), '<strong>$1</strong>')
        : name;
    item.innerHTML = `
        <img class="suggestion-sprite" src="${staticSprite(id)}" alt="${name}" onerror="this.src='https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png';this.onerror=null;">
        <span>${highlighted}</span>
        <span class="suggestion-id">#${String(id).padStart(3,'0')}</span>
    `;
    item.addEventListener('click', () => {
        searchInput.value = name;
        dropdown.classList.remove('visible');
        getPokemon(name);
    });
    return item;
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-wrapper')) dropdown.classList.remove('visible');
});

// ─── Fetch Pokémon ────────────────────────────────────────────────────────────
async function getPokemon(name) {
    const url = `https://pokeapi.co/api/v2/pokemon/${name.toLowerCase().trim()}`;
    clearSearchError();
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`"${name}" wasn't found — check the spelling.`);
        const data = await res.json();
        currentPokemon = data;
        showShiny = false;
        displayPokemon(data);
        dropdown.classList.remove('visible');
    } catch(err) { showSearchError(err.message); }
}

function showSearchError(msg) {
    let el = document.getElementById('search-error');
    if (!el) {
        el = document.createElement('div');
        el.id = 'search-error';
        document.getElementById('search-wrapper').appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('visible');
}

function clearSearchError() {
    const el = document.getElementById('search-error');
    if (el) el.classList.remove('visible');
}

// ─── Display preview card ─────────────────────────────────────────────────────
function displayPokemon(data) {
    const card = document.getElementById('pokemon-card');
    const types = data.types.map(t => t.type.name);
    const primaryType = types[0];
    const typeBadges = types.map(type =>
        `<span class="type-badge" style="background-color:${typeColours[type]||'#999'}">${type}</span>`
    ).join('');
    const hasShiny   = !!data.sprites.front_shiny;
    const hasAnimated = !!data.sprites?.versions?.['generation-v']?.['black-white']?.animated?.front_default;
    const allStats = data.stats.map((s, i) =>
        `<p><span>${statNames[i]}</span><strong>${s.base_stat}</strong></p>`
    ).join('');

    card.innerHTML = `
        <div class="card preview-card" style="border-left:4px solid ${typeColours[primaryType]||'#ccc'}">
            <div class="sprite-controls">
                ${hasShiny   ? `<button class="sprite-toggle-btn ${showShiny?'active':''}" onclick="toggleShiny()">✨ Shiny</button>` : ''}
                ${hasAnimated? `<button class="sprite-toggle-btn ${showAnimated?'active':''}" onclick="toggleAnimated()">▶ Animated</button>` : ''}
            </div>
            <img id="preview-sprite" src="${getSprite(data)}" alt="${escHtml(data.name)}">
            <h2>${escHtml(data.name.toUpperCase())}</h2>
            <p class="pokedex-number">#${String(data.id).padStart(3,'0')}</p>
            <div class="type-badges">${typeBadges}</div>
            <div class="stats">${allStats}</div>
            <div class="card-actions">
                <button onclick="addToTeam()">Add to Team</button>
                <button class="secondary-btn" data-action="open-details" data-name="${escHtml(data.name)}">Details</button>
            </div>
        </div>
    `;
}

function toggleShiny()    { if (!currentPokemon) return; showShiny    = !showShiny;    displayPokemon(currentPokemon); }
function toggleAnimated() { if (!currentPokemon) return; showAnimated = !showAnimated; displayPokemon(currentPokemon); }

// ─── Details modal ────────────────────────────────────────────────────────────
async function openDetailsModal(pokemonName) {
    const overlay = document.getElementById('details-overlay');
    const content = document.getElementById('details-content');
    overlay.classList.add('visible');
    content.innerHTML = '<div class="details-loading">Loading...</div>';

    try {
        const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${pokemonName}`);
        const poke    = await pokeRes.json();
        // Use species URL from the pokemon data — handles form variants correctly
        // e.g. meowstic-male → species/meowstic, lycanroc-dusk → species/lycanroc
        const speciesRes = await fetch(poke.species.url);
        const species = await speciesRes.json();

        // Flavour text — pick first English entry
        const flavourEntry = species.flavor_text_entries.find(e => e.language.name === 'en');
        const flavour = flavourEntry
            ? flavourEntry.flavor_text.replace(/\f/g, ' ').replace(/\n/g, ' ')
            : 'No Pokédex entry available.';

        // Abilities
        const abilities = poke.abilities.map(a =>
            `<span class="detail-tag">${a.ability.name.replace('-',' ')}${a.is_hidden?' <em>(hidden)</em>':''}</span>`
        ).join('');

        // Types
        const types = poke.types.map(t => t.type.name);
        const typeBadges = types.map(t =>
            `<span class="type-badge" style="background-color:${typeColours[t]||'#999'}">${t}</span>`
        ).join('');

        // Evolution chain — parsed as proper branching paths so regional
        // form variants (e.g. sneasel-hisui → sneasler) are kept on their
        // own line rather than merged with the base form's path.
        const evoRes  = await fetch(species.evolution_chain.url);
        const evoData = await evoRes.json();
        const evoPaths = getEvoPaths(evoData.chain); // [ [a,b,c], [a,b2] … ]

        // Find all regional/form variants per species name from the master list
        // Only surface regional/form variants that have genuine gameplay differences.
        // We limit to known regional suffixes to avoid pulling in cosmetic variants
        // (e.g. pikachu-original-cap, pikachu-world-cap) which aren't real evolutions.
        const REGIONAL_SUFFIXES = ['alola','alolan','galar','galarian','hisui','hisuian','paldea','paldean'];
        // Battle-form suffixes that are transformations, not real evolutions —
        // exclude from the evo chain entirely.
        const BATTLE_FORM_SUFFIXES = [
            'mega','mega-x','mega-y',     // Mega Evolution
            'primal',                      // Primal Reversion
            'gmax',                        // Gigantamax
            'totem',                       // Totem forms
            'eternamax',                   // Eternatus
            'origin',                      // Giratina-Origin, Dialga-Origin etc.
            'crowned',                     // Zacian/Zamazenta crowned
            'bloodmoon',                   // Ursaluna-Bloodmoon (real form, but not in evo chain)
        ];
        function getVariants(speciesName) {
            const base = allPokemon.find(p => p.name === speciesName);
            const forms = allPokemon.filter(p => {
                if (p.name === speciesName) return false;
                if (!p.name.startsWith(speciesName + '-')) return false;
                const suffix = p.name.slice(speciesName.length + 1).toLowerCase();
                // Never include battle-form transformations in evo chains
                if (BATTLE_FORM_SUFFIXES.includes(suffix)) return false;
                // Include known regional forms
                if (REGIONAL_SUFFIXES.some(r => suffix === r || suffix.startsWith(r + '-'))) return true;
                // Include simple single-word suffixes (midday, midnight, male, female, dusk…)
                // but exclude multi-word cosmetic variants (original-cap, world-cap etc.)
                return !suffix.includes('-');
            });
            return base ? [base, ...forms] : forms;
        }

        // Build one evo step node for a specific pokemon name
        function evoStepHtml(name, speciesName) {
            const entry = allPokemon.find(p => p.name === name);
            if (!entry) return '';
            const isCurrent = name === pokemonName;
            const suffix = name !== speciesName
                ? name.slice(speciesName.length + 1).toUpperCase()
                : '';
            const label = suffix
                ? speciesName.toUpperCase() + '<br><small>' + suffix + '</small>'
                : speciesName.toUpperCase();
            return '<div class="evo-step ' + (isCurrent ? 'evo-current' : '') + '"'
                + ' data-action="evo-step" data-name="' + escHtml(name) + '">'
                + '<img src="' + staticSprite(entry.id) + '" alt="' + escHtml(name) + '">'
                + '<span>' + label + '</span></div>';
        }

        // Assign each path to a specific form variant where there's ambiguity.
        // Strategy: if a species appears as the START of multiple paths, map each
        // extra path to a regional form variant (in order) so Sneasel → Weavile
        // stays on the base line and Sneasel-Hisui → Sneasler gets its own line.
        function assignPathForms(paths) {
            // Count how many paths start with each species
            const startCounts = {};
            paths.forEach(path => {
                startCounts[path[0]] = (startCounts[path[0]] || 0) + 1;
            });

            const formAssignments = {}; // pathIndex → override name for path[0]
            const usedForms = {};       // speciesName → how many variants used so far

            paths.forEach((path, i) => {
                const rootSpecies = path[0];
                if (startCounts[rootSpecies] > 1) {
                    const used = usedForms[rootSpecies] || 0;
                    if (used === 0) {
                        // First path keeps base form — no override
                    } else {
                        const variants = getVariants(rootSpecies);
                        // variants[0] is base, variants[1..] are forms
                        const form = variants[used]; // used=1 → first form variant
                        if (form) formAssignments[i] = form.name;
                    }
                    usedForms[rootSpecies] = (usedForms[rootSpecies] || 0) + 1;
                }
            });
            return formAssignments;
        }

        const formAssignments = assignPathForms(evoPaths);

        const pathRows = evoPaths.map((path, pathIdx) => {
            const steps = path.map((speciesName, stepIdx) => {
                // For the first step of a branching path, check if we have a
                // form override (e.g. replace sneasel with sneasel-hisui)
                let displayName = speciesName;
                if (stepIdx === 0 && formAssignments[pathIdx]) {
                    displayName = formAssignments[pathIdx];
                }

                // For non-first steps with only 1 path through them, show all
                // form variants stacked (e.g. lycanroc midday/midnight/dusk)
                const isShared = evoPaths.filter(p => p.includes(speciesName)).length > 1;
                if (!isShared && stepIdx > 0) {
                    const variants = getVariants(speciesName);
                    if (variants.length > 1) {
                        const stacked = variants.map(v => evoStepHtml(v.name, speciesName)).join('');
                        return '<div class="evo-forms-group">' + stacked + '</div>';
                    }
                }

                return evoStepHtml(displayName, speciesName);
            });

            return steps.join('<span class="evo-arrow">→</span>');
        });

        // Battle forms (Mega, Primal, Gmax etc.) — shown as a separate appendage
        // below the main chain, clearly labelled as transformations not evolutions.
        function getBattleForms(speciesName) {
            return allPokemon.filter(p => {
                if (!p.name.startsWith(speciesName + '-')) return false;
                const suffix = p.name.slice(speciesName.length + 1).toLowerCase();
                return BATTLE_FORM_SUFFIXES.includes(suffix)
                    || BATTLE_FORM_SUFFIXES.some(b => suffix.startsWith(b + '-'));
            });
        }

        // Collect battle forms for the last species in each path
        const allLastSpecies = [...new Set(evoPaths.map(p => p[p.length - 1]))];
        const battleFormEntries = allLastSpecies.flatMap(s => getBattleForms(s));

        // Build battle form steps — same visual style as regular evo steps,
        // appended inline after the last stage with a regular arrow.
        let battleFormsHtml = '';
        if (battleFormEntries.length > 0) {
            const allSpeciesInChain = evoPaths.flat();
            const battleSteps = battleFormEntries.map(function(entry) {
                const isCurrent = entry.name === pokemonName;
                const speciesName = allSpeciesInChain.find(function(s) {
                    return entry.name.startsWith(s + '-');
                }) || entry.name;
                const suffix = entry.name.slice(speciesName.length + 1).toUpperCase();
                const currentClass = isCurrent ? 'evo-current' : '';
                const fallbackSrc = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/' + entry.id + '.png';
                const escapedName = entry.name.replace(/'/g, "\'");
                return '<div class="evo-step ' + currentClass + '"'
                    + ' data-action="evo-step" data-name="' + escHtml(entry.name) + '">'
                    + '<img src="' + staticSprite(entry.id) + '"'
                    + ' alt="' + escHtml(entry.name) + '"'
                    + ' onerror="this.src=\'' + fallbackSrc + '\';this.onerror=null;">'
                    + '<span>' + speciesName.toUpperCase() + '<br><small>' + suffix + '</small></span>'
                    + '</div>';
            });
            // Wrap multiple battle forms in a vertical group, single one is just a step
            const battleContent = battleSteps.length > 1
                ? '<div class="evo-forms-group">' + battleSteps.join('') + '</div>'
                : battleSteps[0];
            battleFormsHtml = '<span class="evo-arrow">→</span>' + battleContent;
        }

        // Append battle forms inline at the end of the chain
        const baseChain = evoPaths.length > 1
            ? pathRows.map(row => '<div class="evo-path-row">' + row + '</div>').join('')
            : pathRows[0] || '';
        const evoHtml = evoPaths.length > 1
            ? baseChain  // branching chains (Sneasel): don't append to avoid ambiguity
            : baseChain + battleFormsHtml;

        // Stat bars
        const statBars = poke.stats.map((s, i) => {
            const pct = Math.round((s.base_stat / statMax[i]) * 100);
            const colour = pct > 66 ? '#4CAF50' : pct > 33 ? '#FF9800' : '#f44336';
            return `
                <div class="stat-bar-row">
                    <span class="stat-bar-label">${statNames[i]}</span>
                    <div class="stat-bar-track">
                        <div class="stat-bar-fill" style="width:${pct}%;background:${colour}"></div>
                    </div>
                    <span class="stat-bar-val">${s.base_stat}</span>
                </div>
            `;
        }).join('');

        content.innerHTML = `
            <div class="details-header" style="border-top: 5px solid ${typeColours[types[0]]||'#ccc'}">
                <img class="details-sprite" src="${getBestSprite(poke, showShiny)}" alt="${poke.name}">
                <div class="details-title">
                    <h2>${poke.name.toUpperCase()}</h2>
                    <p class="pokedex-number">#${String(poke.id).padStart(3,'0')} &bull; ${species.genera.find(g=>g.language.name==='en')?.genus || ''}</p>
                    <div class="type-badges">${typeBadges}</div>
                    <p class="details-flavour">"${flavour}"</p>
                </div>
            </div>

            <div class="details-body">
                <div class="details-col">
                    <h3>Info</h3>
                    <div class="info-grid">
                        <span>Height</span><span>${(poke.height / 10).toFixed(1)} m</span>
                        <span>Weight</span><span>${(poke.weight / 10).toFixed(1)} kg</span>
                        <span>Base XP</span><span>${poke.base_experience || '—'}</span>
                        <span>Capture Rate</span><span>${species.capture_rate}</span>
                        <span>Happiness</span><span>${species.base_happiness ?? '—'}</span>
                        <span>Growth</span><span>${species.growth_rate.name.replace('-',' ')}</span>
                    </div>
                    <h3 style="margin-top:16px">Abilities</h3>
                    <div class="abilities-row">${abilities}</div>
                </div>

                <div class="details-col">
                    <h3>Base Stats</h3>
                    <div class="stat-bars">${statBars}</div>
                    <p class="stat-total">Total: <strong>${poke.stats.reduce((a,s)=>a+s.base_stat,0)}</strong></p>
                </div>
            </div>

            <div class="details-evo">
                <h3>Evolution Chain</h3>
                <div class="evo-chain">${evoHtml}</div>
            </div>

            <div class="details-footer">
                <button data-action="load-into-builder" data-name="${escHtml(poke.name)}">Load into Builder</button>
            </div>
        `;
    } catch(err) {
        content.innerHTML = `<p class="empty-hint">Could not load details for ${pokemonName}.</p>`;
    }
}

function closeDetailsModal() {
    document.getElementById('details-overlay').classList.remove('visible');
}

async function loadIntoBuilder(name) {
    closeDetailsModal();
    await getPokemon(name);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Returns all root-to-leaf paths through an evolution chain.
// e.g. Sneasel's chain yields [ ['sneasel','weavile'], ['sneasel','sneasler'] ]
// This preserves branching so regional-form evolutions stay on their own line.
function getEvoPaths(chain) {
    if (!chain.evolves_to || chain.evolves_to.length === 0) {
        return [[chain.species.name]];
    }
    const paths = [];
    chain.evolves_to.forEach(next => {
        getEvoPaths(next).forEach(subPath => {
            paths.push([chain.species.name, ...subPath]);
        });
    });
    return paths;
}

// ─── Team management ──────────────────────────────────────────────────────────
function addToTeam() {
    if (!currentPokemon) return;
    if (team.length >= MAX_TEAM_SIZE) { alert("Your team is full!"); return; }
    if (team.some(p => p.name === currentPokemon.name)) {
        alert(`${currentPokemon.name.toUpperCase()} is already on your team!`); return;
    }
    team.push(currentPokemon);
    renderTeam(); analyzeTeam(); renderSummary(); renderCompareSection();
}

function removeFromTeam(index) {
    if (compareA && compareA.name === team[index].name) compareA = null;
    if (compareB && compareB.name === team[index].name) compareB = null;
    team.splice(index, 1);
    renderTeam(); analyzeTeam(); renderSummary(); renderCompareSection();
}

function moveInTeam(index, direction) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= team.length) return;
    [team[index], team[newIndex]] = [team[newIndex], team[index]];
    renderTeam(); analyzeTeam(); renderSummary();
}

function clearTeam() {
    if (team.length === 0) return;
    if (confirm('Clear your entire team?')) {
        team = []; compareA = null; compareB = null;
        renderTeam(); analyzeTeam(); renderSummary(); renderCompareSection();
    }
}

function renderTeam() {
    const display  = document.getElementById('team-cards');
    const counter  = document.getElementById('team-count');
    const saveBtn  = document.getElementById('save-team-btn');
    const exportBtn = document.getElementById('export-team-btn');

    counter.textContent = `${team.length} / ${MAX_TEAM_SIZE}`;
    saveBtn.disabled = team.length === 0;
    exportBtn.disabled = team.length === 0;
    if (team.length === 0) { exportBtn.dataset.format = 'plain'; exportBtn.textContent = 'Copy: Plain'; }
    const shareBtn = document.getElementById('share-url-btn');
    if (shareBtn) shareBtn.disabled = team.length === 0;

    if (team.length === 0) {
        display.innerHTML = '<p class="empty-hint">No Pokémon on your team yet.</p>';
        return;
    }

    display.innerHTML = team.map((pokemon, index) => {
        const types = pokemon.types.map(t => t.type.name);
        const primaryType = types[0];
        const typeBadges = types.map(type =>
            `<span class="type-badge" style="background-color:${typeColours[type]||'#999'}">${type}</span>`
        ).join('');
        return `
            <div class="card team-card" style="border-top:4px solid ${typeColours[primaryType]||'#ccc'}">
                <div class="team-card-order">
                    <button class="order-btn" onclick="moveInTeam(${index},-1)" ${index===0?'disabled':''}>▲</button>
                    <button class="order-btn" onclick="moveInTeam(${index},1)"  ${index===team.length-1?'disabled':''}>▼</button>
                </div>
                <img src="${getBestSprite(pokemon)}" alt="${escHtml(pokemon.name)}" style="cursor:pointer"
                    data-action="open-details" data-name="${escHtml(pokemon.name)}">
                <h3>${escHtml(pokemon.name.toUpperCase())}</h3>
                <p class="pokedex-number">#${String(pokemon.id).padStart(3,'0')}</p>
                <div class="type-badges">${typeBadges}</div>
                <button class="remove-btn" onclick="removeFromTeam(${index})">Remove</button>
            </div>
        `;
    }).join('');
}

function exportTeam() {
    if (team.length === 0) return;
    // Cycle through export formats on each click
    const formats = ['plain','showdown','markdown'];
    const btn = document.getElementById('export-team-btn');
    const current = btn.dataset.format || 'plain';
    const next = formats[(formats.indexOf(current) + 1) % formats.length];

    let text = '';
    if (current === 'plain') {
        text = team.map(p =>
            `${p.name.toUpperCase()} (#${String(p.id).padStart(3,'0')}) [${p.types.map(t=>t.type.name).join('/')}]`
        ).join('\n');
    } else if (current === 'showdown') {
        // Pokémon Showdown import format
        text = team.map(p => {
            const name = p.name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('-');
            return `${name}\nAbility: ${p.abilities[0]?.ability.name.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) || 'None'}\n`;
        }).join('\n');
    } else {
        // Markdown table
        text = `| # | Pokémon | Types | HP | Atk | Def | SpAtk | SpDef | Speed |\n`;
        text += `|---|---------|-------|----|----|-----|-------|-------|-------|\n`;
        text += team.map(p => {
            const s = p.stats;
            const types = p.types.map(t=>t.type.name).join('/');
            return `| #${String(p.id).padStart(3,'0')} | ${p.name.toUpperCase()} | ${types} | ${s[0].base_stat} | ${s[1].base_stat} | ${s[2].base_stat} | ${s[3].base_stat} | ${s[4].base_stat} | ${s[5].base_stat} |`;
        }).join('\n');
    }

    navigator.clipboard.writeText(text).then(() => {
        const labels = { plain: 'Plain Text', showdown: 'Showdown', markdown: 'Markdown' };
        btn.textContent = `✓ ${labels[current]} Copied!`;
        btn.dataset.format = next;
        const nextLabels = { plain: 'Copy: Plain', showdown: 'Copy: Showdown', markdown: 'Copy: Markdown' };
        setTimeout(() => { btn.textContent = nextLabels[next]; }, 2000);
    });
}

// Initialise button label on load
function initExportBtn() {
    const btn = document.getElementById('export-team-btn');
    btn.dataset.format = 'plain';
    btn.textContent = 'Copy: Plain';
}

// ─── Compare mode ─────────────────────────────────────────────────────────────
function renderCompareSection() {
    renderCompareSlots();
    renderCompareChart();
}

function renderCompareSlots() {
    const slotA = document.getElementById('compare-slot-a');
    const slotB = document.getElementById('compare-slot-b');

    slotA.innerHTML = compareA
        ? `<img src="${getBestSprite(compareA)}" alt="${compareA.name}">
           <span>${compareA.name.toUpperCase()}</span>
           <button class="clear-compare-btn" onclick="clearCompareSlot('a')">✕</button>`
        : `<span class="compare-slot-placeholder">+ Pick Pokémon A</span>`;

    slotB.innerHTML = compareB
        ? `<img src="${getBestSprite(compareB)}" alt="${compareB.name}">
           <span>${compareB.name.toUpperCase()}</span>
           <button class="clear-compare-btn" onclick="clearCompareSlot('b')">✕</button>`
        : `<span class="compare-slot-placeholder">+ Pick Pokémon B</span>`;
}

function renderCompareChart() {
    const chart = document.getElementById('compare-chart');
    if (!compareA || !compareB) { chart.innerHTML = ''; return; }

    const statsA = compareA.stats.map(s => s.base_stat);
    const statsB = compareB.stats.map(s => s.base_stat);
    const typesA = compareA.types.map(t=>t.type.name)[0];
    const typesB = compareB.types.map(t=>t.type.name)[0];
    const colA = typeColours[typesA] || '#CC0000';
    const colB = typeColours[typesB] || '#3333CC';

    const rows = statNames.map((name, i) => {
        const a = statsA[i], b = statsB[i];
        const maxVal = Math.max(a, b, statMax[i]);
        const pctA = Math.round((a / maxVal) * 100);
        const pctB = Math.round((b / maxVal) * 100);
        const winA = a > b ? 'compare-win' : '';
        const winB = b > a ? 'compare-win' : '';
        return `
            <div class="compare-row">
                <span class="compare-val ${winA}">${a}</span>
                <div class="compare-bars">
                    <div class="compare-bar-left"  style="width:${pctA}%;background:${colA}"></div>
                    <div class="compare-bar-label">${name}</div>
                    <div class="compare-bar-right" style="width:${pctB}%;background:${colB}"></div>
                </div>
                <span class="compare-val ${winB}">${b}</span>
            </div>
        `;
    }).join('');

    const totalA = statsA.reduce((a,b)=>a+b,0);
    const totalB = statsB.reduce((a,b)=>a+b,0);

    chart.innerHTML = `
        <div class="compare-chart-header">
            <span style="color:${colA}">${compareA.name.toUpperCase()}</span>
            <span class="compare-chart-vs">STATS</span>
            <span style="color:${colB}">${compareB.name.toUpperCase()}</span>
        </div>
        ${rows}
        <div class="compare-row compare-total-row">
            <span class="compare-val ${totalA>totalB?'compare-win':''}">${totalA}</span>
            <div class="compare-bars"><div class="compare-bar-label">Total</div></div>
            <span class="compare-val ${totalB>totalA?'compare-win':''}">${totalB}</span>
        </div>
    `;
}

function openComparePicker(slot) {
    currentComparePicker = slot;
    const modal = document.getElementById('picker-overlay');
    document.getElementById('picker-title').textContent = `Choose Pokémon ${slot.toUpperCase()}`;
    const grid = document.getElementById('picker-grid');

    // Section 1: team members
    let html = '';
    if (team.length > 0) {
        html += '<div class="picker-section-label">Your Team</div>';
        html += '<div class="picker-section-row">';
        html += team.map((pokemon, index) => {
            const primaryType = pokemon.types[0].type.name;
            return `<div class="picker-card" onclick="selectCompare(${index})" style="border-top:3px solid ${typeColours[primaryType]||'#ccc'}">
                <img src="${getBestSprite(pokemon)}" alt="${pokemon.name}">
                <span>${pokemon.name.toUpperCase()}</span>
            </div>`;
        }).join('');
        html += '</div>';
    } else {
        html += '<p class="empty-hint" style="font-size:0.8rem;margin-bottom:10px">No Pokémon on your team yet.</p>';
    }

    // Section 2: current recommended picks (if any)
    if (lastRecPools && lastRecPools.length > 0) {
        const used = new Set();
        const recSuggestions = lastRecPools.map(({ pool }) => {
            for (let i = 0; i < pool.length; i++) {
                const c = pool[(recOffset + i) % pool.length];
                if (!used.has(c)) { used.add(c); return c; }
            }
            return pool[recOffset % pool.length];
        }).filter(Boolean);

        if (recSuggestions.length > 0) {
            html += '<div class="picker-section-label">Recommended Picks</div>';
            html += '<div class="picker-section-row">';
            html += recSuggestions.map(name => {
                const entry = allPokemon.find(p => p.name === name);
                if (!entry) return '';
                const fallbackUrl = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/' + entry.id + '.png';
                return `<div class="picker-card picker-card-rec" data-action="compare-by-name" data-name="${escHtml(name)}">
                    <img src="${staticSprite(entry.id)}" alt="${escHtml(name)}"
                        onerror="this.src='${fallbackUrl}';this.onerror=null;">
                    <span>${escHtml(name.toUpperCase())}</span>
                </div>`;
            }).join('');
            html += '</div>';
        }
    }

    grid.innerHTML = html;
    modal.classList.add('visible');
}

function selectCompare(index) {
    if (currentComparePicker === 'a') compareA = team[index];
    else compareB = team[index];
    closeComparePicker();
    renderCompareSection();
}

async function selectCompareByName(name) {
    const slot = currentComparePicker; // capture before closeComparePicker() nulls it
    closeComparePicker();
    try {
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`);
        const data = await res.json();
        if (slot === 'a') compareA = data;
        else compareB = data;
        renderCompareSection();
    } catch(e) { alert('Could not load ' + name); }
}

function closeComparePicker() {
    document.getElementById('picker-overlay').classList.remove('visible');
    currentComparePicker = null;
}

function clearCompareSlot(slot) {
    if (slot === 'a') compareA = null;
    else compareB = null;
    renderCompareSection();
}

// ─── Analysis ─────────────────────────────────────────────────────────────────
function analyzeTeam() {
    const analysisEl  = document.getElementById('analysis-content');
    const recommendEl = document.getElementById('recommendations-content');

    if (team.length === 0) {
        analysisEl.innerHTML  = '<p class="empty-hint">Add Pokémon to see coverage and weaknesses.</p>';
        recommendEl.innerHTML = '<p class="empty-hint">Build your team to get suggestions.</p>';
        return;
    }

    // All types currently represented on the team (used to avoid duplicate type recs)
    const teamTypes = [...new Set(team.flatMap(p => p.types.map(t => t.type.name)))];

    // Proper dual-type aware weakness counts across the whole team
    const weaknessCounts = getTeamWeaknessCounts(team);
    const sortedWeaknesses = Object.entries(weaknessCounts).sort((a,b) => b[1]-a[1]);

    const coverageBadges = teamTypes.map(type =>
        `<span class="type-badge" style="background-color:${typeColours[type]||'#999'}">${type}</span>`
    ).join('');
    const weaknessBadges = sortedWeaknesses.map(([type, count]) =>
        `<span class="type-badge weakness-badge ${count>=3?'weakness-critical':''}" style="background-color:${typeColours[type]||'#999'}">${type} ×${count}</span>`
    ).join('');

    analysisEl.innerHTML = `
        <div class="analysis-block">
            <p class="analysis-label">Types covered</p>
            <div class="badge-row">${coverageBadges}</div>
        </div>
        <div class="analysis-block">
            <p class="analysis-label">Weak to</p>
            <div class="badge-row">${weaknessBadges || '<span class="empty-hint">No notable weaknesses!</span>'}</div>
        </div>
    `;

    if (team.length >= MAX_TEAM_SIZE) { recommendEl.innerHTML = '<p class="empty-hint">Your team is full.</p>'; return; }

    // ── Recommendation logic ──────────────────────────────────────────────────

    // 1. Work out the gen range to filter suggestions by
    const genVal = document.getElementById('gen-filter').value;
    const genRange = genVal !== 'all' ? genRanges[genVal] : null;

    // 2. Helper: is a Pokémon name within the selected gen?
    function isInGen(name) {
        if (!genRange) return true;
        const entry = allPokemon.find(p => p.name === name);
        if (!entry) return false;
        return entry.id >= genRange[0] && entry.id <= genRange[1];
    }

    // 3. Score each type by how many of the team's top weaknesses it covers,
    //    but only consider types NOT already on the team (no type doubling up)
    const topWeaknesses = sortedWeaknesses.slice(0, 4).map(([type]) => type);
    const scores = {};
    Object.entries(typeStrengths).forEach(([type, strengths]) => {
        if (teamTypes.includes(type)) return; // skip types already on team
        const score = strengths.filter(s => topWeaknesses.includes(s)).length;
        if (score > 0) scores[type] = score;
    });

    const topTypes = Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([type]) => type);

    if (topTypes.length === 0) {
        recommendEl.innerHTML = '<p class="empty-hint">Your team looks well balanced!</p>';
        return;
    }

    // 4. Show a loading state then fetch full type rosters from PokéAPI.
    //    Results are cached so each type is only fetched once per session.
    recommendEl.innerHTML = '<p class="rec-hint">Loading recommendations…</p>';

    recOffset = 0; // reset position on team change
    buildRecPools(topTypes, isInGen).then(recPools => {
        renderRecCards(recPools);
    });
}

// Fetches (or returns cached) full Pokémon list for each type, filtered and shuffled.
async function buildRecPools(topTypes, isInGen) {
    const pools = await Promise.all(topTypes.map(async type => {
        // Fetch from API if not cached
        if (!typePoolCache[type]) {
            try {
                const res  = await fetch(`https://pokeapi.co/api/v2/type/${type}`);
                const data = await res.json();
                // Keep only base-form names (no hyphens that indicate a variant,
                // except compound names like ho-oh, porygon-z, jangmo-o etc.)
                // Strategy: cross-reference against allPokemon and only include
                // entries whose id is <= 1010 (no home-only forms) and whose name
                // exists in our master list.
                const names = data.pokemon
                    .map(p => p.pokemon.name)
                    .filter(name => allPokemon.some(p => p.name === name));
                // Shuffle once on fetch so each session gets a different order
                for (let i = names.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [names[i], names[j]] = [names[j], names[i]];
                }
                typePoolCache[type] = names;
            } catch(e) {
                // Fall back to hardcoded list if API fails
                typePoolCache[type] = typeReps[type] || [];
            }
        }

        const cached = typePoolCache[type];

        // Apply filters: not already on team, within selected gen
        const filtered = cached.filter(name =>
            !team.some(p => p.name === name) && isInGen(name)
        );

        // If gen filter yields nothing, fall back to just not-on-team
        const pool = filtered.length > 0
            ? filtered
            : cached.filter(name => !team.some(p => p.name === name));

        return { type, pool: pool.length > 0 ? pool : cached };
    }));
    return pools;
}

// Global rec offset — one number advances all three slots together
let recOffset = 0;

function renderRecCards(recPools) {
    lastRecPools = recPools;
    const recommendEl = document.getElementById('recommendations-content');

    // Deduplicate across slots: once a Pokémon is picked for one type slot,
    // skip it in the others so the same dual-type mon never appears twice.
    const used = new Set();
    const suggestions = recPools.map(({ type, pool }) => {
        // Walk from recOffset until we find one not already used this render
        for (let i = 0; i < pool.length; i++) {
            const candidate = pool[(recOffset + i) % pool.length];
            if (!used.has(candidate)) {
                used.add(candidate);
                return { type, name: candidate };
            }
        }
        return { type, name: pool[recOffset % pool.length] }; // fallback
    });

    const recCards = suggestions.map(({ type, name, pool }) => {
        const entry = allPokemon.find(p => p.name === name);
        const spriteUrl = entry ? staticSprite(entry.id) : '';
        const fallbackUrl = entry
            ? 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/' + entry.id + '.png'
            : '';
        const escapedName = name ? name.replace(/'/g, "\'") : '';
        return `
        <div class="rec-card">
            <span class="type-badge rec-type-badge" style="background-color:${typeColours[type]||'#999'}">${type}</span>
            ${spriteUrl ? `<img class="rec-sprite" src="${spriteUrl}" alt="${escHtml(name)}"
                onerror="this.src='${fallbackUrl}';this.onerror=null;">` : ''}
            <p class="rec-name">${name ? escHtml(name.toUpperCase()) : '—'}</p>
            <div class="rec-btn-group">
                ${name ? `<button class="rec-btn" data-action="preview-rec" data-name="${escHtml(name)}">Preview</button>` : ''}
                ${name ? `<button class="rec-btn rec-compare-btn" data-action="compare-rec" data-name="${escHtml(name)}">Compare</button>` : ''}
            </div>
        </div>
    `}).join('');

    recommendEl.innerHTML = `
        <div class="rec-header">
            <p class="rec-hint">To cover your team's weaknesses, consider:</p>
            <button class="refresh-btn rec-refresh-all" onclick="refreshAllRecs()">↻ Refresh</button>
        </div>
        <div class="rec-row">${recCards}</div>
    `;
}

function refreshAllRecs() {
    recOffset++;
    if (lastRecPools) {
        renderRecCards(lastRecPools);
    } else {
        analyzeTeam();
    }
}

// ─── Shareable URL ────────────────────────────────────────────────────────────
function getShareableUrl() {
    const names = team.map(p => p.name).join(',');
    const url = new URL(window.location.href.split('?')[0]);
    url.searchParams.set('team', names);
    return url.toString();
}

async function shareTeamUrl() {
    if (team.length === 0) return;
    const url = getShareableUrl();
    try {
        await navigator.clipboard.writeText(url);
        const btn = document.getElementById('share-url-btn');
        const orig = btn.textContent;
        btn.textContent = '✓ Link Copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch(e) { prompt('Copy this link:', url); }
}

async function loadTeamFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const teamParam = params.get('team');
    if (!teamParam) return;
    const names = teamParam.split(',').map(n => n.trim()).filter(Boolean).slice(0, 6);
    if (names.length === 0) return;
    // Show a banner so users know a shared team is being loaded
    const banner = document.createElement('div');
    banner.id = 'url-load-banner';
    banner.textContent = `Loading shared team (${names.length} Pokémon)…`;
    document.body.prepend(banner);
    try {
        const results = await Promise.all(names.map(name =>
            fetch(`https://pokeapi.co/api/v2/pokemon/${name}`).then(r => r.ok ? r.json() : null)
        ));
        team = results.filter(Boolean);
        renderTeam(); analyzeTeam(); renderSummary(); renderCompareSection();
    } catch(e) { console.warn('Could not load team from URL', e); }
    banner.remove();
}

async function previewRecommendation(name) {
    searchInput.value = name;
    await getPokemon(name);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function addRecToCompare(name) {
    // Fetch the pokemon data, then slot into whichever compare slot is empty,
    // or cycle: if both filled replace the older one (always B), if A empty fill A.
    let data;
    try {
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`);
        if (!res.ok) throw new Error();
        data = await res.json();
    } catch(e) { alert('Could not load ' + name); return; }

    if (!compareA)      compareA = data;
    else if (!compareB) compareB = data;
    else                compareB = data; // both filled → replace B
    renderCompareSection();
    document.getElementById('compare-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}


// ─── Team Summary ──────────────────────────────────────────────────────────────
function renderSummary() {
    const el = document.getElementById('summary-content');

    if (team.length < 6) {
        el.innerHTML = '<p class="empty-hint">Complete your team to see a full summary.</p>';
        return;
    }

    // ── Collect data ──────────────────────────────────────────────────────────
    const teamTypes = [...new Set(team.flatMap(p => p.types.map(t => t.type.name)))];
    const weaknessCounts = getTeamWeaknessCounts(team);

    // Resistances & immunities across team
    const resistCounts = {};
    const immuneCounts = {};
    team.forEach(pokemon => {
        const mults = getPokemonWeaknessMultipliers(pokemon);
        Object.entries(mults).forEach(([attacker, mult]) => {
            if (mult === 0)    immuneCounts[attacker]  = (immuneCounts[attacker]  || 0) + 1;
            else if (mult <= 0.5) resistCounts[attacker] = (resistCounts[attacker] || 0) + 1;
        });
    });

    // Total base stat sum across team
    const totalStats = team.map(p => p.stats.reduce((a, s) => a + s.base_stat, 0));
    const teamStatTotal = totalStats.reduce((a, b) => a + b, 0);
    const avgStat = Math.round(teamStatTotal / 6);

    // Identify the highest/lowest stat member
    const strongest = team[totalStats.indexOf(Math.max(...totalStats))];
    const weakestMember = team[totalStats.indexOf(Math.min(...totalStats))];

    // ── Scoring ───────────────────────────────────────────────────────────────
    let score = 100;
    const notes = [];
    const strengths = [];

    // Penalise critical weaknesses (3+ members weak to same type)
    const criticalWeaknesses = Object.entries(weaknessCounts).filter(([, c]) => c >= 3);
    const badWeaknesses      = Object.entries(weaknessCounts).filter(([, c]) => c === 2);
    score -= criticalWeaknesses.length * 12;
    score -= badWeaknesses.length * 4;
    criticalWeaknesses.forEach(([type, count]) => {
        notes.push(`${count}/6 members are weak to <strong>${type}</strong> — a major vulnerability.`);
    });
    badWeaknesses.forEach(([type]) => {
        notes.push(`Two members share a <strong>${type}</strong> weakness.`);
    });

    // Reward type diversity
    const typeDiversity = teamTypes.length;
    if (typeDiversity >= 8) { score += 8; strengths.push('Excellent type diversity (' + typeDiversity + ' types covered).'); }
    else if (typeDiversity >= 6) { score += 4; strengths.push('Good type diversity (' + typeDiversity + ' types covered).'); }
    else { score -= 6; notes.push('Low type diversity — only ' + typeDiversity + ' types represented.'); }

    // Reward immunities
    const immunityCount = Object.keys(immuneCounts).length;
    if (immunityCount >= 3) { score += 6; strengths.push(immunityCount + ' type immunities on the team.'); }
    else if (immunityCount >= 1) { score += 2; strengths.push(immunityCount + ' type immunit' + (immunityCount > 1 ? 'ies' : 'y') + ' on the team.'); }

    // Reward high avg base stat total
    if (avgStat >= 490)      { score += 6; strengths.push('High average base stat total (' + avgStat + ').'); }
    else if (avgStat >= 440) { score += 2; }
    else                     { score -= 4; notes.push('Below-average base stat total (avg ' + avgStat + ').'); }

    // Check coverage of the 6 most common attacking types in competitive play
    const keyOffensiveTypes = ['fire','water','electric','ice','fighting','ground'];
    const coveredOffense = keyOffensiveTypes.filter(t => teamTypes.includes(t));
    if (coveredOffense.length >= 5) { score += 4; strengths.push('Strong offensive coverage across key types.'); }
    else if (coveredOffense.length <= 2) { score -= 4; notes.push('Limited offensive type coverage.'); }

    score = Math.max(0, Math.min(100, score));

    const grade = score >= 90 ? 'S' : score >= 78 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';
    const gradeColour = score >= 90 ? '#4CAF50' : score >= 78 ? '#8BC34A' : score >= 65 ? '#FF9800' : score >= 50 ? '#FF5722' : '#f44336';

    // ── Weakness & resistance badge rows ─────────────────────────────────────
    const sortedWeaknesses = Object.entries(weaknessCounts).sort((a, b) => b[1] - a[1]);
    const weakBadges = sortedWeaknesses.length
        ? sortedWeaknesses.map(([type, count]) =>
            `<span class="type-badge weakness-badge ${count >= 3 ? 'weakness-critical' : ''}"
                style="background-color:${typeColours[type]||'#999'}">${type} ×${count}</span>`
          ).join('')
        : '<span class="summary-good">No weaknesses shared by 2+ members!</span>';

    const topResists = Object.entries(resistCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const resistBadges = topResists.map(([type, count]) =>
        `<span class="type-badge" style="background-color:${typeColours[type]||'#999'};opacity:0.75">${type} ×${count}</span>`
    ).join('');

    const immuneBadges = Object.keys(immuneCounts).length
        ? Object.entries(immuneCounts).map(([type]) =>
            `<span class="type-badge" style="background-color:${typeColours[type]||'#999'}">${type}</span>`
          ).join('')
        : '<span class="empty-hint">None</span>';

    // ── Type coverage badge row ───────────────────────────────────────────────
    const allTypes = Object.keys(typeColours);
    const coverageBadges = allTypes.map(type => {
        const covered = teamTypes.includes(type);
        return `<span class="type-badge ${covered ? '' : 'badge-dim'}"
            style="background-color:${typeColours[type]||'#999'}">${type}</span>`;
    }).join('');

    // ── Notes & strengths ─────────────────────────────────────────────────────
    const strengthsHtml = strengths.length
        ? strengths.map(s => `<li>✅ ${s}</li>`).join('')
        : '<li>No standout strengths detected.</li>';
    const notesHtml = notes.length
        ? notes.map(n => `<li>⚠️ ${n}</li>`).join('')
        : '<li class="summary-good">No major issues found — great team!</li>';

    el.innerHTML = `
        <div class="summary-grid">
            <div class="summary-score-col">
                <div class="summary-score-ring" style="--score-colour:${gradeColour}">
                    <span class="summary-score-num">${score}</span>
                    <span class="summary-score-label">/ 100</span>
                </div>
                <div class="summary-grade" style="color:${gradeColour}">Grade: ${grade}</div>
                <div class="summary-members">${team.map(p => p.name.toUpperCase()).join(', ')}</div>
                <div class="summary-types-label">Types covered</div>
                <div class="type-badges summary-team-types">${coverageBadges}</div>
            </div>

            <div class="summary-detail-col">
                <div class="summary-block">
                    <div class="summary-section-label">⚔️ Weaknesses</div>
                    <div class="badge-row">${weakBadges}</div>
                </div>
                <div class="summary-block">
                    <div class="summary-section-label">🛡️ Resistances (most covered)</div>
                    <div class="badge-row">${resistBadges}</div>
                </div>
                <div class="summary-block">
                    <div class="summary-section-label">🚫 Immunities</div>
                    <div class="badge-row">${immuneBadges}</div>
                </div>
                <div class="summary-block">
                    <div class="summary-section-label">💪 Strengths</div>
                    <ul class="summary-list">${strengthsHtml}</ul>
                </div>
                <div class="summary-block">
                    <div class="summary-section-label">📋 Notes</div>
                    <ul class="summary-list">${notesHtml}</ul>
                </div>
                <div class="summary-block">
                    <div class="summary-section-label">📊 Stat Overview</div>
                    <p class="summary-stat-line">Avg BST: <strong>${avgStat}</strong> &bull;
                        Strongest: <strong>${strongest.name.toUpperCase()}</strong> (${Math.max(...totalStats)}) &bull;
                        Lowest BST: <strong>${weakestMember.name.toUpperCase()}</strong> (${Math.min(...totalStats)})</p>
                </div>
            </div>
        </div>
    `;
}

// ─── Save / load teams ────────────────────────────────────────────────────────
function openSaveModal() {
    document.getElementById('modal-overlay').classList.add('visible');
    setTimeout(() => document.getElementById('team-name-input').focus(), 50);
}

function closeSaveModal() {
    document.getElementById('modal-overlay').classList.remove('visible');
    document.getElementById('team-name-input').value = '';
}

function confirmSaveTeam() {
    const name = document.getElementById('team-name-input').value.trim();
    if (!name) { alert('Please enter a team name.'); return; }
    if (name.length > 50) { alert('Team name must be 50 characters or fewer.'); return; }
    const savedAt = new Date().toLocaleDateString([], { day: '2-digit', month: 'short' })
        + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // Check for duplicate name and confirm overwrite
    const existingIdx = savedTeams.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    if (existingIdx !== -1) {
        if (!confirm(`A team called "${name}" already exists. Overwrite it?`)) return;
        savedTeams[existingIdx] = { name, pokemon: [...team], savedAt };
    } else {
        savedTeams.push({ name, pokemon: [...team], savedAt });
    }
    persistSavedTeams();
    closeSaveModal();
    renderSavedTeams();
}

function renderSavedTeams() {
    const container = document.getElementById('saved-teams-list');
    if (savedTeams.length === 0) { container.innerHTML = '<p class="empty-hint">No saved teams yet.</p>'; return; }
    container.innerHTML = savedTeams.map((saved, index) => {
        const miniCards = saved.pokemon.map(p =>
            `<img class="mini-sprite" src="${getBestSprite(p)}" alt="${p.name}" title="${p.name.toUpperCase()}">`
        ).join('');
        return `
            <div class="saved-team-row">
                <div class="saved-team-info">
                    <strong>${escHtml(saved.name)}</strong>
                    <span class="saved-time">${escHtml(saved.savedAt)} &bull; ${saved.pokemon.length} Pokémon</span>
                </div>
                <div class="saved-sprites">${miniCards}</div>
                <div class="saved-team-btns">
                    <button onclick="loadSavedTeam(${index})">Load</button>
                    <button class="remove-btn" onclick="deleteSavedTeam(${index})">Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

function loadSavedTeam(index) {
    if (confirm(`Load "${savedTeams[index].name}"? This will replace your current team.`)) {
        team = [...savedTeams[index].pokemon];
        compareA = null; compareB = null;
        renderTeam(); analyzeTeam(); renderSummary(); renderCompareSection();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function deleteSavedTeam(index) {
    if (confirm(`Delete "${savedTeams[index].name}"?`)) {
        savedTeams.splice(index, 1);
        persistSavedTeams();
        renderSavedTeams();
    }
}

// ─── Event listeners ──────────────────────────────────────────────────────────
document.getElementById('search-button').addEventListener('click', () => {
    const name = searchInput.value.trim();
    if (name) getPokemon(name);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { dropdown.classList.remove('visible'); const name = searchInput.value.trim(); if (name) getPokemon(name); }
});

document.getElementById('save-team-btn').addEventListener('click', openSaveModal);
document.getElementById('clear-team-btn').addEventListener('click', clearTeam);
document.getElementById('export-team-btn').addEventListener('click', exportTeam);
document.getElementById('modal-confirm').addEventListener('click', confirmSaveTeam);
document.getElementById('modal-cancel').addEventListener('click', closeSaveModal);
document.getElementById('team-name-input').addEventListener('keydown', e => { if (e.key==='Enter') confirmSaveTeam(); });
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target===document.getElementById('modal-overlay')) closeSaveModal(); });
document.getElementById('details-overlay').addEventListener('click', e => { if (e.target===document.getElementById('details-overlay')) closeDetailsModal(); });
document.getElementById('picker-overlay').addEventListener('click', e => { if (e.target===document.getElementById('picker-overlay')) closeComparePicker(); });

// ─── Delegated listeners (replaces inline onclick handlers in dynamic HTML) ───
// Handles clicks on team cards — sprite image and Details button open the modal.
document.getElementById('team-cards').addEventListener('click', e => {
    const el = e.target.closest('[data-action="open-details"]');
    if (el) openDetailsModal(el.dataset.name);
});

// Handles the preview card Details button.
document.getElementById('pokemon-card').addEventListener('click', e => {
    const el = e.target.closest('[data-action="open-details"]');
    if (el) openDetailsModal(el.dataset.name);
});

// Handles clicks inside the details modal — evo steps and Load into Builder.
document.getElementById('details-overlay').addEventListener('click', e => {
    const evo = e.target.closest('[data-action="evo-step"]');
    if (evo) { closeDetailsModal(); getPokemon(evo.dataset.name); return; }
    const load = e.target.closest('[data-action="load-into-builder"]');
    if (load) loadIntoBuilder(load.dataset.name);
});

// Handles Preview and Compare buttons on recommendation cards.
document.getElementById('recommendations-content').addEventListener('click', e => {
    const preview = e.target.closest('[data-action="preview-rec"]');
    if (preview) { previewRecommendation(preview.dataset.name); return; }
    const compare = e.target.closest('[data-action="compare-rec"]');
    if (compare) addRecToCompare(compare.dataset.name);
});

// Handles recommended picks inside the compare picker modal.
document.getElementById('picker-grid').addEventListener('click', e => {
    const el = e.target.closest('[data-action="compare-by-name"]');
    if (el) selectCompareByName(el.dataset.name);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadPersistedTeams(); // restore saved teams from localStorage before first render
initExportBtn();
loadAllPokemonNames().then(loadTeamFromUrl);
renderTeam();
analyzeTeam();
renderSummary();
renderSavedTeams();
renderCompareSection();
