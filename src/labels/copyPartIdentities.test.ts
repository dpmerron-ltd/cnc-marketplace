import { expect, it } from 'vitest'
import { copyPartIdentities } from './copyPartIdentities'
import type { Sheet } from '../models/Sheet'
it('gives recalled physical copies independent IDs and retains order and partner links', () => {
  const sheet = { instances: [{id:'first',partId:'component',recutId:'old-recut',sharedEdgePartnerId:'second'},{id:'second',partId:'component'}],pendingParts:[{id:'pending',partId:'component'}],orderImports:[{key:'shop/123',name:'#123',instanceIds:['first','second','pending']}] } as Sheet
  const copy=copyPartIdentities(sheet)
  expect(new Set([...copy.instances,...copy.pendingParts!].map(i=>i.id)).size).toBe(3)
  expect(copy.instances[0].id).not.toBe('first')
  expect(copy.instances[0].sharedEdgePartnerId).toBe(copy.instances[1].id)
  expect(copy.instances[0].recutId).toBeUndefined()
  expect(copy.orderImports![0].instanceIds).toEqual([...copy.instances,...copy.pendingParts!].map(i=>i.id))
  expect(copy.instances.map(i=>i.partId)).toEqual(['component','component'])
  expect(sheet.instances[0].id).toBe('first')
})
