'use client'
import { type ReactNode, createContext, useContext } from 'react'

/** Who's in, as the pages' acts need it: their name, and whether they came in with World ID (D35). Those acts World
 *  App proves alone: the wallet signed in already. */
export type Visitor = { name: string; world: boolean } | null

const Who = createContext<Visitor>(null)

export function VisitorIs({ who, children }: { who: Visitor; children: ReactNode }) {
  return <Who value={who}>{children}</Who>
}

export const useVisitor = () => useContext(Who)
