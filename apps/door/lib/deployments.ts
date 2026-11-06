import type { Address } from 'viem'
import deployments from '../../../contracts/deployments/480.json'

/** World ID's environments: staging answers the Simulator, production the World App (R4). */
export type Environment = 'staging' | 'production'

export const CHAIN_ID = deployments.chainId

/** Our KnockBinding in each environment: what the device signs a binding for. */
export const KNOCK_BINDING: Record<Environment, Address> = {
  staging: deployments.staging.KnockBinding as Address,
  production: deployments.production.KnockBinding as Address,
}

/** The World ID action a human's first binding proves there: one per deployment, proved once per human (D24). */
export const ACTION: Record<Environment, string> = {
  staging: deployments.staging.action,
  production: deployments.production.action,
}

export const EXPLORER = 'https://worldscan.org'
