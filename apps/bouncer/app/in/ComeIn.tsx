'use client'
import { Act } from '../Act'

/** Coming in: a knock, or World ID and a wallet */
export function ComeIn() {
  return <Act label="Knock in" worldLabel="Come in with World ID" intent={() => ({ act: 'in' })} />
}
