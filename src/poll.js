import { v4 as uuidv4 } from 'uuid';

/**
 * Creates a new poll with the given options
 * @param {Object} params Poll parameters including options, open and close times
 * @param {KVNamespace} kv The KV namespace to store the poll data
 * @returns {Object} The created poll object
 */
export async function createPoll(params, kv) {
    const id = uuidv4();
    const poll = {
        id,
        open: params.open || new Date().toISOString(),
        close: params.close || new Date(Date.now() + 24*60*60*1000).toISOString(), // Default 24h from now
        options: params.options.map(opt => ({
            name: opt.name,
            url: opt.url,
            votes: 0
        }))
    };

    await kv.put(id, JSON.stringify(poll));

    console.log('Poll created:', poll);
    console.log('KV binding:', kv);

    //read the poll from the kv
    const pollData = await kv.get(id);
    console.log('Poll data:', pollData);

    return poll;
}

/**
 * Vote on a specific option in a poll
 * @param {string} pollId The ID of the poll
 * @param {number} optionIndex The index of the option to vote for
 * @param {KVNamespace} kv The KV namespace storing the poll data
 * @returns {Object} The updated poll object
 */
export async function vote(pollId, optionIndex, kv) {
    const pollData = await kv.get(pollId);
    if (!pollData) {
        throw new Error('Poll not found');
    }

    const poll = JSON.parse(pollData);
    const now = new Date();
    
    if (new Date(poll.open) > now) {
        throw new Error('Poll has not opened yet');
    }
    if (new Date(poll.close) < now) {
        throw new Error('Poll has closed');
    }
    
    if (optionIndex < 0 || optionIndex >= poll.options.length) {
        throw new Error('Invalid option index');
    }

    poll.options[optionIndex].votes++;
    await kv.put(pollId, JSON.stringify(poll));
    
    return poll;
}

/**
 * Get a poll from the KV namespace
 * @param {string} pollId The ID of the poll
 * @param {KVNamespace} kv The KV namespace storing the poll data
 * @returns {Object} The parsed poll object
 */
export async function getPoll(pollId, kv) {
    const pollData = await kv.get(pollId);
    if (!pollData) {
        throw new Error('Poll not found');
    }
    return JSON.parse(pollData);
} 