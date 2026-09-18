import { describe, expect, it, vi } from 'vitest';
import { createProjectService } from './project-service.js';
import { createChatService } from '../chat/chat-service.js';

function fixture(count: number) {
  const query: any = {then: (resolve: any) => Promise.resolve({error:null,count}).then(resolve)};
  for (const method of ['update','delete','eq','is']) query[method]=vi.fn(()=>query);
  return {query,createUserClient:vi.fn(()=>({from:vi.fn(()=>query)})) as any};
}
const user={id:'user',accessToken:'test-token'} as any;
describe('mutation row counts',()=>{
  it.each([0,1])('requests exact project update count and handles %i rows',async count=>{
    const f=fixture(count);
    const service=createProjectService({createUserClient:f.createUserClient,viewerService:{} as any});
    const operation=service.updateProject(user,'project',{name:'Updated'});
    if(count===0)await expect(operation).rejects.toMatchObject({code:'project_not_found',statusCode:404});
    else await expect(operation).resolves.toBeUndefined();
    expect(f.query.update).toHaveBeenCalledWith({name:'Updated'},{count:'exact'});
    expect(f.query.is).toHaveBeenCalledWith('archived_at',null);
  });
  it.each(['updateSessionTitle','deleteSession'] as const)('rejects zero-row %s',async method=>{
    const f=fixture(0);
    const service=createChatService({createUserClient:f.createUserClient,threadService:{createThreadId:()=> 'thread'}});
    const operation=method==='updateSessionTitle'?service[method](user,'session','Updated'):service[method](user,'session');
    await expect(operation).rejects.toMatchObject({code:'session_not_found',statusCode:404});
    if(method==='updateSessionTitle')expect(f.query.update).toHaveBeenCalledWith({title:'Updated'},{count:'exact'});
    else expect(f.query.delete).toHaveBeenCalledWith({count:'exact'});
  });
});
