/** Literal, deterministic keyword search shared by scoped diary and chat reads.
 * Splitting a model's keyword list does not invent synonyms or personal facts. */
export function searchTerms(query){
 if(typeof query!=='string')return[];
 return [...new Set(query.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(Boolean))];
}

/** Zero means no keyword matched; each distinct matching keyword adds one.
 * Callers retain their own identity filters and stable tie/pagination order. */
export function scoreRecord(text,query){
 if(typeof text!=='string')return 0;
 const value=text.toLowerCase();
 return searchTerms(query).reduce((score,term)=>score+(value.includes(term)?1:0),0);
}
