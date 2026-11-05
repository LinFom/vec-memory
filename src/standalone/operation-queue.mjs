// Model I/O must not block reads of already committed memory. Mutations retain
// their single-writer order, and outstanding readers finish before the next write.
export function createOperationQueue(prepare=async()=>{}) {
  let tail=Promise.resolve(),readWindow=false;
  const readers=new Set();
  function run(fn,{longRunning=false,readOnly=false}={}) {
    if(readWindow&&readOnly){
      const result=Promise.resolve().then(fn);readers.add(result);
      void result.finally(()=>readers.delete(result)).catch(()=>{});return result;
    }
    const result=tail.catch(()=>{}).then(async()=>{
      await prepare();readWindow=longRunning;
      try{return await fn();}
      finally{readWindow=false;await Promise.allSettled([...readers]);}
    });
    tail=result;return result;
  }
  return {run};
}
