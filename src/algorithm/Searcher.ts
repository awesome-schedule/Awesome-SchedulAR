/**
 * @module src/algorithm
 * @author Hanzhi Zhou
 */

/**
 * The struture of the objects used to store search results
 */
export interface SearchResult<T, K = string> {
    /** the score of this result */
    score: number;
    /** an array of pairs indicating the indices of match. [[1,2], [7,9]] means that the indices [1, 2) and [7, 9) of the string are matched */
    matches: number[];
    /** index of the item in the original list */
    index: number;
    /** original_list[index] */
    item: T;
    /** some arbitrary data associated with this item */
    data: K;
}
/**
 * Fast searcher for fuzzy search among a list of strings
 */
export class FastSearcher<T, K = string> {
    public readonly originals: string[] = [];

    private readonly idxOffsets: Uint32Array;
    private readonly indices: Uint32Array;
    private readonly tokenIds: Uint32Array;

    private readonly tokenScores: Float32Array;
    private readonly scoreWindow: Float32Array;

    private readonly uniqueTokens: string[] = [];
    private maxTokenLen = 0;

    /**
     * @param items the list of strings to search from
     * @param data some arbitrary data that will be passed to each search result
     */
    constructor(
        public items: T[],
        toStr: (a: T) => string = x => x as any,
        public data: K = '' as any
    ) {
        const allTokens: string[][] = [];
        let tokenLen = 0;
        this.idxOffsets = new Uint32Array(items.length + 1);
        for (let i = 0; i < items.length; i++) {
            const full = toStr(items[i])
                .trimEnd()
                .toLowerCase();
            this.originals.push(full);
            const temp = full.split(/\s+/);
            allTokens.push(temp);

            this.idxOffsets[i] = tokenLen;
            tokenLen += temp.length;
            if (temp.length > this.maxTokenLen) this.maxTokenLen = temp.length;
        }
        this.idxOffsets[items.length] = tokenLen;

        this.indices = new Uint32Array(tokenLen);
        this.tokenIds = new Uint32Array(tokenLen);

        const str2num = new Map<string, number>();
        for (let j = 0; j < allTokens.length; j++) {
            const tokens = allTokens[j];
            const offset = this.idxOffsets[j];
            const t0 = tokens[0];
            if (!str2num.has(t0)) {
                str2num.set(t0, this.uniqueTokens.length);
                this.uniqueTokens.push(t0);
            }
            this.tokenIds[offset] = str2num.get(t0)!;
            const original = this.originals[j];
            for (let i = 1; i < tokens.length; i++) {
                const token = tokens[i];
                if (!str2num.has(token)) {
                    str2num.set(token, this.uniqueTokens.length);
                    this.uniqueTokens.push(token);
                }
                this.tokenIds[offset + i] = str2num.get(token)!;
                this.indices[offset + i] = original.indexOf(
                    token,
                    this.indices[offset + i - 1] + tokens[i - 1].length
                );
            }
        }
        this.scoreWindow = new Float32Array(this.maxTokenLen);
        this.tokenScores = new Float32Array(this.uniqueTokens.length);

        console.log('all tokens', tokenLen);
        console.log('unique tokens', this.uniqueTokens.length);
    }
    private constructQueryGrams(query: string, gramLen: number) {
        /** map from n-gram to index in the frequency array */
        const queryGrams = new Map<string, number>();
        const queryGramCount = query.length - gramLen + 1;

        // keep frequencies in separated arrays for performance reasons
        // copying a Map is slow, but copying a typed array is fast
        const buffer = new ArrayBuffer(queryGramCount * 4);
        const freqCount = new Uint16Array(buffer, 0, queryGramCount);
        // the working copy
        const freqCountCopy = new Uint16Array(buffer, queryGramCount * 2, queryGramCount);

        for (let j = 0, idx = 0; j < queryGramCount; j++) {
            const grams = query.substring(j, j + gramLen);
            const eIdx = queryGrams.get(grams);
            if (eIdx !== undefined) {
                freqCount[eIdx] += 1;
            } else {
                queryGrams.set(grams, idx);
                freqCount[idx++] = 1;
            }
        }
        return [queryGrams, freqCount, freqCountCopy] as const;
    }
    public findBestMatch(query: string) {
        query = query
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');

        const [queryGrams, freqCount, freqCountCopy] = this.constructQueryGrams(query, 2);

        let bestMatchIndex = 0;
        let bestMatchRating = 0;
        for (let i = 0; i < this.originals.length; i++) {
            freqCountCopy.set(freqCount);
            const currentTargetString = this.originals[i];
            const currentRating = this.compareTwoStrings(
                queryGrams,
                freqCountCopy,
                query,
                currentTargetString
            );
            if (currentRating > bestMatchRating) {
                bestMatchIndex = i;
                bestMatchRating = currentRating;
            }
        }
        return [bestMatchIndex, bestMatchRating];
    }
    /**
     * Adapted from [[https://github.com/aceakash/string-similarity]], with optimizations
     */
    public compareTwoStrings(
        bigrams: Map<string, number>,
        freqCount: Uint16Array,
        first: string,
        second: string
    ) {
        const len1 = first.length,
            len2 = second.length;
        if (!len1 && !len2) return 1; // if both are empty strings
        if (!len1 || !len2) return 0; // if only one is empty string
        if (first === second) return 1; // identical
        if (len1 === 1 && len2 === 1) return 0; // both are 1-letter strings
        if (len1 < 2 || len2 < 2) return 0; // if either is a 1-letter string

        let intersectionSize = 0;
        for (let i = 0; i < len2 - 1; i++) {
            const bigram = second.substring(i, i + 2);
            const idx = bigrams.get(bigram);

            if (idx !== undefined && freqCount[idx] > 0) {
                freqCount[idx]--;
                intersectionSize++;
            }
        }

        return (2.0 * intersectionSize) / (len1 + len2 - 2);
    }
    /**
     * approximate sliding window search, accelerated by inverted index
     * @param query
     * @param maxWindow
     * @param gramLen
     */
    public sWSearch(query: string, gramLen = 3, threshold = 0.03, maxWindow?: number) {
        const t2 = query
            .trim()
            .toLowerCase()
            .split(/\s+/);
        query = t2.join(' ');
        if (query.length <= 2) return [];

        maxWindow = Math.max(maxWindow || t2.length, 2);

        const queryGramCount = query.length - gramLen + 1;
        const [queryGrams, freqCount, freqCountCopy] = this.constructQueryGrams(query, gramLen);

        const len = this.uniqueTokens.length;
        const tokenScores = this.tokenScores;
        const tokenMatches: number[][] = [];
        // compute score for each token
        for (let i = 0; i < len; i++) {
            freqCountCopy.set(freqCount);

            const str = this.uniqueTokens[i];
            const tokenGramCount = str.length - gramLen + 1;
            const matches: number[] = [];
            let intersectionSize = 0;
            for (let j = 0; j < tokenGramCount; j++) {
                const grams = str.substring(j, j + gramLen);
                const idx = queryGrams.get(grams);

                if (idx !== undefined && freqCountCopy[idx] > 0) {
                    freqCountCopy[idx]--;
                    intersectionSize++;
                    matches.push(j, j + gramLen);
                }
            }
            tokenScores[i] = (2 * intersectionSize) / (queryGramCount + tokenGramCount);
            tokenMatches.push(matches);
        }

        // score & matches for each sentence
        const allMatches: SearchResult<T, K>[] = [];
        const scoreWindow = this.scoreWindow;
        for (let i = 0; i < this.originals.length; i++) {
            const matches = [];
            const offset = this.idxOffsets[i];
            const tokenLen = this.idxOffsets[i + 1] - offset;

            // use the number of words as the window size in this string if maxWindow > number of words
            const window = Math.min(maxWindow, tokenLen);

            let score = 0,
                maxScore = 0;
            // initialize score window
            for (let j = 0; j < window; j++) {
                const tokenId = this.tokenIds[offset + j];
                const v = tokenScores[tokenId];
                score += scoreWindow[j] = v;

                if (v < threshold) continue;
                const temp = this.indices[offset + j];
                const tokMatch = tokenMatches[tokenId];
                for (let k = 0; k < tokMatch.length; k++) {
                    matches.push(tokMatch[k] + temp);
                }
            }
            if (score > maxScore) maxScore = score;

            for (let j = window; j < tokenLen; j++) {
                // subtract the last score and add the new score
                score -= scoreWindow[j - window];
                const tokenId = this.tokenIds[offset + j];
                const v = tokenScores[tokenId];
                score += scoreWindow[j] = v;

                if (v < threshold) continue;
                if (score > maxScore) maxScore = score;

                const temp = this.indices[offset + j];
                const tokMatch = tokenMatches[tokenId];
                for (let k = 0; k < tokMatch.length; k++) {
                    matches.push(tokMatch[k] + temp);
                }
            }

            allMatches.push({
                score: maxScore,
                matches,
                item: this.items[i],
                index: i,
                data: this.data
            });
        }

        return allMatches;
    }
    /**
     * exact sliding window search
     * @param query
     * @param maxWindow
     * @param gramLen
     */
    public sWSearchExact(query: string, gramLen = 3, maxWindow?: number) {
        const t2 = query
            .trim()
            .toLowerCase()
            .split(/\s+/);
        query = t2.join(' ');
        if (query.length <= 2) return [];

        maxWindow = Math.max(maxWindow || t2.length, 2);

        const queryGramCount = query.length - gramLen + 1;
        const [queryGrams, freqCount, freqCountCopy] = this.constructQueryGrams(query, gramLen);

        const allMatches: SearchResult<T, K>[] = [];
        for (let i = 0; i < this.originals.length; i++) {
            const matches = [];
            const fullStr = this.originals[i];
            const offset = this.idxOffsets[i];

            // note: nextOffset - offset = num of words + 1
            const nextOffset = this.idxOffsets[i + 1];

            // use the number of words as the window size in this string if maxWindow > number of words
            const window = Math.min(maxWindow, nextOffset - offset);
            let maxScore = 0;
            for (let k = offset; k < nextOffset - window; k++) {
                const start = this.indices[k];
                const end = this.indices[k + window] - gramLen + 1;

                let intersectionSize = 0;
                freqCountCopy.set(freqCount);
                for (let j = start; j < end; j++) {
                    const grams = fullStr.substring(j, j + gramLen);
                    const idx = queryGrams.get(grams);

                    if (idx !== undefined && freqCountCopy[idx]-- > 0) {
                        intersectionSize++;
                        matches.push(j, j + gramLen);
                    }
                }

                const score = (2 * intersectionSize) / (queryGramCount + end - start);
                if (score > maxScore) {
                    maxScore = score;
                }
            }

            allMatches.push({
                score: maxScore,
                matches,
                item: this.items[i],
                index: i,
                data: this.data
            });
        }
        return allMatches;
    }
    public toJSON() {
        return this.originals;
    }
}

/**
 * Fast searcher for fuzzy search among a list of strings
 */
export class FastSearcherNative<T, K = string> {
    public readonly originals: string[] = [];
    private readonly ptr: number;
    constructor(
        public items: readonly T[],
        toStr: (a: T) => string = x => x as any,
        public data: K = '' as any
    ) {
        console.time('start up');
        const Module = window.NativeModule;
        const strArrPtr = Module._malloc(items.length * 4);
        for (let i = 0; i < items.length; i++) {
            const str = toStr(items[i])
                .trim()
                .toLowerCase();
            const strLen = str.length + 1;
            const ptr = Module._malloc(strLen);
            Module.stringToUTF8(str, ptr, strLen);
            Module.HEAPU32[strArrPtr / 4 + i] = ptr;
        }
        this.ptr = Module._getSearcher(strArrPtr, items.length);
        console.timeEnd('start up');
    }

    sWSearch(query: string, numResults: number, gramLen = 2, threshold = 0.05) {
        query = query.trim().toLowerCase();
        const allMatches: SearchResult<T, K>[] = [];

        if (query.length < gramLen) return allMatches;

        const Module = window.NativeModule;
        // TODO: handle UTF-8
        const strLen = query.length + 1;
        const ptr = Module._malloc(strLen);
        Module.stringToUTF8(query, ptr, strLen);

        const resultPtr = Module._sWSearch(this.ptr, ptr, numResults, gramLen, threshold);
        const scoreArr = Module.HEAPF32.subarray(resultPtr / 4);
        const idxArr = Module.HEAP32.subarray(resultPtr / 4);

        const total = Math.min(numResults, this.items.length);

        for (let i = 0; i < total; i++) {
            const idx = idxArr[i * 5 + 1];
            const matchPtr = Module._getMatches(resultPtr + i * 20);
            const matchSize = Module._getMatchSize(resultPtr + i * 20);
            allMatches.push({
                score: scoreArr[i * 5],
                index: idx,
                item: this.items[idx],
                data: this.data,
                matches: Module.HEAP32.subarray(matchPtr / 4, matchPtr / 4 + matchSize * 2) as any
            });
        }
        return allMatches;
    }
}

(window as any).FastSearcher = FastSearcherNative;
