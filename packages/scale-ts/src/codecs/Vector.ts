import { toInternalBytes, mergeUint8 } from "../internal"
import { createCodec } from "../utils"
import { Codec, Decoder, Encoder } from "../types"
import { compact } from "./compact"

const VectorEnc = <T>(inner: Encoder<T>, size?: number): Encoder<Array<T>> =>
  size! >= 0
    ? (value) => mergeUint8(...value.map(inner))
    : (value) => mergeUint8(compact.enc(value.length), ...value.map(inner))

function VectorDec<T>(getter: Decoder<T>, size?: number): Decoder<Array<T>> {
  return toInternalBytes((bytes) => {
    const nElements = size! >= 0 ? size! : compact.dec(bytes)
    const result = new Array(nElements as number)

    for (let i = 0; i < nElements; i++) {
      const current = getter(bytes)
      result[i] = current
    }

    return result
  })
}

export function Vector<T>(inner: Codec<T>, size?: number): Codec<Array<T>> {
  return createCodec(VectorEnc(inner[0], size), VectorDec(inner[1], size))
}

Vector.enc = VectorEnc
Vector.dec = VectorDec
