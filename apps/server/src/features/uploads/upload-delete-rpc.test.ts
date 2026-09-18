import { expect, it, vi } from 'vitest';
import { createUploadService } from './upload-service.js';

it('preserves the Supabase RPC receiver when deleting an authorized orphan upload',async()=>{
  const remove=vi.fn(async()=>({error:null}));
  const client:any={
    from:vi.fn((table:string)=>{
      const chain:any={select:()=>chain,eq:()=>chain,in:()=>chain,
        maybeSingle:async()=>({error:null,data:table==='asset_objects'?{scope:'workspace',workspace_id:'workspace'}:{role:'owner'}})};
      return chain;
    }),
    storage:{from:vi.fn(()=>({remove}))},
    rpc:vi.fn(function(this:unknown,name:string){
      expect(this).toBe(client);
      return Promise.resolve({error:null,data:name==='loomic_orphan_asset_claim'?[{bucket:'workspace-assets',object_path:'workspace/test.png'}]:true});
    }),
  };
  const service=createUploadService({getAdminClient:()=>client,createUserClient:()=>client});
  await service.deleteAsset({id:'owner',accessToken:'test'} as any,'asset');
  expect(remove).toHaveBeenCalledWith(['workspace/test.png']);
  expect(client.rpc).toHaveBeenNthCalledWith(1,'loomic_orphan_asset_claim',{p_asset_id:'asset'});
  expect(client.rpc).toHaveBeenNthCalledWith(2,'loomic_orphan_asset_finalize',{p_asset_id:'asset'});
});
