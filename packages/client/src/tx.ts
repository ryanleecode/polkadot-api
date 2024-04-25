import {
  AssetDescriptor,
  Binary,
  Enum,
  HexString,
  Option,
  Tuple,
  compact,
  u128,
  u32,
} from "@polkadot-api/substrate-bindings"
import { mergeUint8, toHex } from "@polkadot-api/utils"
import {
  Observable,
  concat,
  firstValueFrom,
  lastValueFrom,
  map,
  mergeMap,
  of,
  startWith,
  take,
  withLatestFrom,
} from "rxjs"
import {
  BlockInfo,
  RuntimeContext,
  SystemEvent,
  getObservableClient,
} from "@polkadot-api/observable-client"
import { TrackedTx } from "@polkadot-api/observable-client"
import {
  CompatibilityHelper,
  IsCompatible,
  Runtime,
  getRuntimeContext,
} from "./runtime"
import { PolkadotSigner } from "../../signers/polkadot-signer/dist/index.mjs"

export type TxBroadcastEvent =
  | { type: "broadcasted" }
  | { type: "bestChainBlockIncluded"; block: { hash: string; index: number } }
  | ({
      type: "finalized"
    } & TxFinalizedPayload)
export type TxEvent = TxBroadcastEvent | { type: "signed"; tx: HexString }

export type TxFinalizedPayload = {
  ok: boolean
  events: Array<SystemEvent["event"]>
  block: { hash: string; index: number }
}

const getTxSuccessFromSystemEvents = (
  systemEvents: Array<SystemEvent>,
  txIdx: number,
): Omit<TxFinalizedPayload, "block"> => {
  const events = systemEvents
    .filter((x) => x.phase.type === "ApplyExtrinsic" && x.phase.value === txIdx)
    .map((x) => x.event)

  const lastEvent = events[events.length - 1]
  const ok =
    lastEvent.type === "System" && lastEvent.value.type === "ExtrinsicSuccess"

  return { ok, events }
}

type TxFunction<Asset> = (
  from: PolkadotSigner,
  hintedSignExtensions?: Partial<
    void extends Asset
      ? {
          tip: bigint
          mortal: { mortal: false } | { mortal: true; period: number }
        }
      : {
          tip: bigint
          mortal: { mortal: false } | { mortal: true; period: number }
          asset: Asset
        }
  >,
) => Promise<TxFinalizedPayload>

type TxObservable<Asset> = (
  from: PolkadotSigner,
  hintedSignExtensions?: Partial<
    void extends Asset
      ? {
          tip: bigint
          mortal: { mortal: false } | { mortal: true; period: number }
        }
      : {
          tip: bigint
          mortal: { mortal: false } | { mortal: true; period: number }
          asset: Asset
        }
  >,
) => Observable<TxEvent>

interface TxCall {
  (): Promise<Binary>
  (runtime: Runtime): Binary
}

type TxSigned<Asset> = (
  from: PolkadotSigner,
  hintedSignExtensions?: Partial<
    void extends Asset
      ? {
          tip: bigint
          mortal: { mortal: false } | { mortal: true; period: number }
        }
      : {
          tip: bigint
          mortal: { mortal: false } | { mortal: true; period: number }
          asset: Asset
        }
  >,
) => Promise<string>

export type Transaction<
  Arg extends {} | undefined,
  Pallet extends string,
  Name extends string,
  Asset,
> = {
  sign: TxSigned<Asset>
  signSubmitAndWatch: TxObservable<Asset>
  signAndSubmit: TxFunction<Asset>
  getEncodedData: TxCall
  getEstimatedFees: () => Promise<bigint>
  decodedCall: {
    type: Pallet
    value: {
      type: Name
      value: Arg
    }
  }
}

export interface TxEntry<
  Arg extends {} | undefined,
  Pallet extends string,
  Name extends string,
  Asset,
> {
  (
    ...args: Arg extends undefined ? [] : [data: Arg]
  ): Transaction<Arg, Pallet, Name, Asset>
  isCompatible: IsCompatible
}

export const getSubmitFns = (
  chainHead: ReturnType<ReturnType<typeof getObservableClient>["chainHead$"]>,
  client: ReturnType<typeof getObservableClient>,
) => {
  const tx$ = (tx: string) =>
    concat(
      chainHead.finalized$.pipe(
        take(1),
        mergeMap((finalized) => chainHead.validateTx$(tx, finalized.hash)),
        map((isValid) => {
          if (!isValid) throw new Error("Invalid")
          return { type: "broadcasted" as "broadcasted" }
        }),
      ),
      new Observable<TrackedTx>((observer) => {
        const subscription = chainHead.trackTx$(tx).subscribe(observer)
        subscription.add(
          client.broadcastTx$(tx).subscribe({
            error(e) {
              observer.error(e)
            },
          }),
        )
        return subscription
      }),
    )

  const submit$ = (transaction: HexString): Observable<TxBroadcastEvent> =>
    tx$(transaction).pipe(
      mergeMap((result) => {
        return result.type !== "finalized"
          ? of(result)
          : chainHead.eventsAt$(result.block.hash).pipe(
              map((events) => ({
                ...result,
                ...getTxSuccessFromSystemEvents(
                  events,
                  Number(result.block.index),
                ),
              })),
            )
      }),
    )

  const submit = async (
    transaction: HexString,
  ): Promise<{
    ok: boolean
    events: Array<SystemEvent["event"]>
    block: { hash: string; index: number }
  }> =>
    lastValueFrom(submit$(transaction)).then((x) => {
      if (x.type !== "finalized") throw null
      const result: {
        ok: boolean
        events: Array<SystemEvent["event"]>
        block: { hash: string; index: number }
        type?: any
      } = { ...x }
      delete result.type
      return result
    })

  return { submit$, submit }
}

const feeDetailsDec = Option(Tuple(u128, u128, u128)).dec

export const createTxEntry = <
  Arg extends {} | undefined,
  Pallet extends string,
  Name extends string,
  Asset extends AssetDescriptor<any>,
>(
  pallet: Pallet,
  name: Name,
  assetChecksum: Asset,
  chainHead: ReturnType<ReturnType<typeof getObservableClient>["chainHead$"]>,
  submits: ReturnType<typeof getSubmitFns>,
  signer: (
    from: PolkadotSigner,
    callData: Uint8Array,
    atBlock: BlockInfo,
    hinted?: Partial<{}>,
  ) => Observable<Uint8Array>,
  compatibilityHelper: CompatibilityHelper,
): TxEntry<Arg, Pallet, Name, Asset["_type"]> => {
  const { isCompatible, compatibleRuntime$ } = compatibilityHelper((ctx) =>
    ctx.checksumBuilder.buildCall(pallet, name),
  )
  const checksumError = () =>
    new Error(`Incompatible runtime entry Tx(${pallet}.${name})`)

  const fn = (arg?: Arg): any => {
    const getCallDataWithContext = (
      { dynamicBuilder, asset: [assetEnc, assetCheck] }: RuntimeContext,
      arg: any,
      hinted: Partial<{ asset: any }> = {},
    ) => {
      let returnHinted = hinted
      if (hinted.asset) {
        if (assetChecksum !== assetCheck)
          throw new Error(`Incompatible runtime asset`)
        returnHinted = { ...hinted, asset: assetEnc(hinted.asset) }
      }

      const { location, codec } = dynamicBuilder.buildCall(pallet, name)
      return {
        callData: Binary.fromBytes(
          mergeUint8(new Uint8Array(location), codec.enc(arg)),
        ),
        hinted: returnHinted,
      }
    }

    const getCallData$ = (arg: any, hinted: Partial<{ asset: any }> = {}) =>
      compatibleRuntime$(chainHead, null, checksumError).pipe(
        map((ctx) => getCallDataWithContext(ctx, arg, hinted)),
      )

    const getEncodedData: TxCall = (runtime?: Runtime): any => {
      if (runtime) {
        if (!isCompatible(runtime)) {
          throw checksumError()
        }
        return getCallDataWithContext(getRuntimeContext(runtime), arg).callData
      }
      return firstValueFrom(getCallData$(arg).pipe(map((x) => x.callData)))
    }

    const sign$ = (from: PolkadotSigner, _hinted: any) =>
      getCallData$(arg, _hinted).pipe(
        withLatestFrom(chainHead.finalized$),
        take(1),
        mergeMap(([{ callData, hinted }, finalized]) =>
          signer(from, callData.asBytes(), finalized, hinted),
        ),
      )

    const sign: TxSigned<Asset> = (from, _hinted) =>
      firstValueFrom(sign$(from, _hinted)).then(toHex)

    const signAndSubmit: TxFunction<Asset> = (from, _hinted) =>
      sign(from, _hinted).then(submits.submit)

    const signSubmitAndWatch: TxObservable<Asset> = (from, _hinted) =>
      sign$(from, _hinted).pipe(
        mergeMap((result) => {
          const tx = toHex(result)
          return submits
            .submit$(tx)
            .pipe(startWith({ type: "signed" as const, tx }))
        }),
      )

    const getEstimatedFees = async () => {
      const encoded = (await getEncodedData()).asBytes()
      const preLen = encoded.length + 103 // TODO: `103` accounts for the extra aprox length that it's added into the extrinsic once it's signed. In the future we should improve this.
      const len = preLen + compact.enc(preLen).length
      const args = toHex(mergeUint8(encoded, u32.enc(len)))

      return firstValueFrom(
        chainHead
          .call$(null, "TransactionPaymentCallApi_query_call_fee_details", args)
          .pipe(
            map((x) => {
              const result = feeDetailsDec(x)
              if (!result) throw new Error("Unable to calculate tx fees")
              return result.reduce((a, b) => a + b)
            }),
          ),
      )
    }

    return {
      getEstimatedFees,
      decodedCall: {
        type: pallet,
        value: Enum(name, arg as any),
      },
      getEncodedData,
      sign,
      signSubmitAndWatch,
      signAndSubmit,
    }
  }

  return Object.assign(fn, { isCompatible })
}
