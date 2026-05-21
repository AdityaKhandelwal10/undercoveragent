// Pure game logic for Undercover. No DOM, no storage, no network.
// Shared by the browser (local mode, via window.GameEngine) and the
// Cloudflare Worker (online mode, via import). UMD wrapper supports both.
(function (root, factory) {
    const engine = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = engine;
    } else {
        root.GameEngine = engine;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // In-place Fisher-Yates shuffle.
    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    // Validate a setup. Returns { valid, error }.
    function validateSetup(playerCount, undercoverCount, mrwhiteCount) {
        if (playerCount < 3) {
            return { valid: false, error: 'Please add at least 3 players' };
        }
        const totalNonCivilians = undercoverCount + mrwhiteCount;
        const maxNonCivilians = Math.floor((playerCount - 1) / 2);
        if (totalNonCivilians === 0) {
            return { valid: false, error: 'Need at least one infiltrator (Undercover or Mr. White)' };
        }
        if (totalNonCivilians > maxNonCivilians) {
            return {
                valid: false,
                error: `Civilians must be majority. Max ${maxNonCivilians} Undercover + Mr. White for ${playerCount} players`
            };
        }
        return { valid: true, error: null };
    }

    // Assign roles to players in place (player.role).
    function assignRoles(players, undercoverCount, mrwhiteCount) {
        const roles = [];
        for (let i = 0; i < undercoverCount; i++) roles.push('undercover');
        for (let i = 0; i < mrwhiteCount; i++) roles.push('mrwhite');
        while (roles.length < players.length) roles.push('civilian');
        shuffleArray(roles);
        players.forEach((player, index) => {
            player.role = roles[index];
        });
        return players;
    }

    // Pick a civilian/undercover word pair from the dictionary.
    // Dictionary shape: { baseWord: [relatedWord, ...], ... }.
    // Throws on empty/invalid input.
    function pickWordPair(wordDictionary) {
        const baseWords = Object.keys(wordDictionary || {});
        if (baseWords.length === 0) {
            throw new Error('Word list is empty');
        }
        const randomBase = baseWords[Math.floor(Math.random() * baseWords.length)];
        const relatedWords = wordDictionary[randomBase];
        if (!Array.isArray(relatedWords) || relatedWords.length === 0) {
            throw new Error('Invalid word configuration');
        }
        const allWords = [randomBase, ...relatedWords];
        shuffleArray(allWords);
        return { civilian: allWords[0], undercover: allWords[1] };
    }

    // Assign words to players in place based on role.
    function assignWords(players, wordPair) {
        players.forEach(player => {
            if (player.role === 'civilian') {
                player.word = wordPair.civilian;
            } else if (player.role === 'undercover') {
                player.word = wordPair.undercover;
            } else {
                player.word = null; // Mr. White has no word
            }
        });
        return players;
    }

    // Tally a flat array of voted-for names into { name: count }.
    function tallyVotes(votes) {
        const voteCounts = {};
        votes.forEach(vote => {
            voteCounts[vote] = (voteCounts[vote] || 0) + 1;
        });
        return voteCounts;
    }

    // Determine who is eliminated from the votes (ties broken randomly).
    // Returns the eliminated player name, or null if there are no votes.
    function resolveEliminationName(votes) {
        const voteCounts = tallyVotes(votes);
        let maxVotes = 0;
        let candidates = [];
        for (const [name, count] of Object.entries(voteCounts)) {
            if (count > maxVotes) {
                maxVotes = count;
                candidates = [name];
            } else if (count === maxVotes) {
                candidates.push(name);
            }
        }
        if (candidates.length === 0) return null;
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Check whether Mr. White's guess of the civilian word is correct.
    function isMrWhiteGuessCorrect(guess, wordPair) {
        return (guess || '').trim().toLowerCase() === (wordPair.civilian || '').toLowerCase();
    }

    // Win check over the currently active (non-eliminated) players.
    // Returns 'civilians' | 'infiltrators' | null (game continues).
    function checkWinCondition(players) {
        const activePlayers = players.filter(p => !p.isEliminated);
        const civilians = activePlayers.filter(p => p.role === 'civilian');
        const undercovers = activePlayers.filter(p => p.role === 'undercover');
        const mrwhites = activePlayers.filter(p => p.role === 'mrwhite');
        const infiltrators = undercovers.length + mrwhites.length;

        if (infiltrators === 0) return 'civilians';
        if (infiltrators >= civilians.length) return 'infiltrators';
        return null;
    }

    return {
        shuffleArray,
        validateSetup,
        assignRoles,
        pickWordPair,
        assignWords,
        tallyVotes,
        resolveEliminationName,
        isMrWhiteGuessCorrect,
        checkWinCondition
    };
});
