import { PalletData } from "./types"
import fs from "fs/promises"
import { ESLint } from "eslint"
import { CodeDeclarations } from "@polkadot-api/substrate-codegen"
import fsExists from "fs.promises.exists"
import tsc from "tsc-prog"
import path from "path"

export const createDescriptorsFile = async (
  key: string,
  outputFolder: string,
  declarations: CodeDeclarations,
  pallets: Record<string, PalletData>,
) => {
  let descriptorCodegen = ""
  const descriptorImports = ["getPalletCreator"]

  descriptorCodegen += `import {${[
    ...new Set([...declarations.imports, ...descriptorImports]),
  ].join(", ")}} from "@polkadot-api/substrate-bindings"\n`
  descriptorCodegen += `import type {${[...declarations.variables.values()]
    .map((v) => v.id)
    .join(", ")}} from "./${key}-types.d.ts"\n\n`

  descriptorCodegen += `let NOTIN: any\n\n`

  const getPayloadType = (payload: string) =>
    `NOTIN as unknown as ${
      declarations.imports.has(payload)
        ? `CodecType<typeof ${payload}>`
        : payload
    }`

  const errorDescriptors: string[] = []
  const eventDescriptors: string[] = []
  const constDescriptors: string[] = []
  const stgDescriptors: string[] = []
  const txDescriptors: string[] = []
  for (const [
    pallet,
    { errors, events, constants, storage, tx },
  ] of Object.entries(pallets)) {
    descriptorCodegen += `const [_${pallet}P, _${pallet}S, _${pallet}T] = getPalletCreator(\"${pallet}\")\n\n`

    for (const [errorName, { checksum, payload }] of Object.entries(errors)) {
      const varName = `Err${pallet}${errorName}`
      descriptorCodegen += `const ${varName} = _${pallet}P("${checksum}", "${errorName}", ${getPayloadType(
        payload,
      )})\n`
      errorDescriptors.push(varName)
    }
    descriptorCodegen += `\n`

    for (const [evName, { checksum, payload }] of Object.entries(events)) {
      const varName = `Ev${pallet}${evName}`
      descriptorCodegen += `const ${varName} = _${pallet}P("${checksum}", "${evName}", ${getPayloadType(
        payload,
      )})\n`
      eventDescriptors.push(varName)
    }
    descriptorCodegen += `\n`

    for (const [constName, { checksum, payload }] of Object.entries(
      constants,
    )) {
      const varName = `Const${pallet}${constName}`
      descriptorCodegen += `const ${varName} = _${pallet}P("${checksum}", "${constName}", ${getPayloadType(
        payload,
      )})\n`
      constDescriptors.push(varName)
    }
    descriptorCodegen += `\n`

    for (const [txName, { checksum, payload }] of Object.entries(tx)) {
      const varName = `Tx${pallet}${txName}`
      descriptorCodegen += `const ${varName} = _${pallet}T("${checksum}", "${txName}", ${getPayloadType(
        payload,
      )})\n`
      txDescriptors.push(varName)
    }
    descriptorCodegen += `\n`

    for (const [
      stgName,
      { checksum, payload, key, isOptional, len },
    ] of Object.entries(storage)) {
      const varName = `Stg${pallet}${stgName}`
      descriptorCodegen += `const ${varName} = _${pallet}S("${checksum}", "${stgName}", ${getPayloadType(
        key,
      )}, ${getPayloadType(payload)}, ${len}, ${isOptional ? 0 : 1})\n`
      stgDescriptors.push(varName)
    }
    descriptorCodegen += `\n\n`
  }
  descriptorCodegen += `\n\n`

  descriptorCodegen += `const _allTxDescriptors: [${txDescriptors
    .map((x) => `typeof ${x}`)
    .join(", ")}] = [${txDescriptors.join(", ")}]\n`
  descriptorCodegen += `const _allStgDescriptors: [${stgDescriptors
    .map((x) => `typeof ${x}`)
    .join(", ")}] = [${stgDescriptors.join(", ")}]\n`
  descriptorCodegen += `const _allConstDescriptors: [${constDescriptors
    .map((x) => `typeof ${x}`)
    .join(", ")}] = [${constDescriptors.join(", ")}]\n`
  descriptorCodegen += `const _allEvtDescriptors: [${eventDescriptors
    .map((x) => `typeof ${x}`)
    .join(", ")}] = [${eventDescriptors.join(", ")}]\n`
  descriptorCodegen += `const _allErrDescriptors: [${errorDescriptors
    .map((x) => `typeof ${x}`)
    .join(", ")}] = [${errorDescriptors.join(", ")}]\n`
  descriptorCodegen += `const _allDescriptors: [
    typeof _allStgDescriptors,
    typeof _allTxDescriptors,
    typeof _allEvtDescriptors,
    typeof _allErrDescriptors,
    typeof _allConstDescriptors
  ] =[
    _allStgDescriptors,
    _allTxDescriptors,
    _allEvtDescriptors,
    _allErrDescriptors,
    _allConstDescriptors
  ]\n`
  descriptorCodegen += `export default _allDescriptors`

  descriptorCodegen = "// Generated by @polkadot-api/cli\n" + descriptorCodegen

  await fs.writeFile(`${outputFolder}/${key}.ts`, descriptorCodegen)

  const eslint = new ESLint({
    useEslintrc: false,
    fix: true,
    overrideConfig: {
      extends: ["plugin:prettier/recommended"],
      parser: "@typescript-eslint/parser",
      plugins: ["@typescript-eslint", "unused-imports", "prettier"],
      rules: {
        "unused-imports/no-unused-imports": "error",
        "unused-imports/no-unused-vars:": "error",
        "max-len": ["error", { code: 120, ignoreUrls: true }],
      },
    },
  })

  const results = await eslint.lintFiles([`${outputFolder}/${key}.ts`])
  await ESLint.outputFixes(results)

  // Run tsc again to make sure the final .ts file has no compile errors
  {
    const tscFileName = path.join(outputFolder, key)
    if (await fsExists(`${tscFileName}.d.ts`)) {
      await fs.rm(`${tscFileName}.d.ts`)
    }

    tsc.build({
      basePath: outputFolder,
      compilerOptions: {
        skipLibCheck: true,
        emitDeclarationOnly: true,
        declaration: true,
        target: "esnext",
        module: "esnext",
        moduleResolution: "node",
      },
      include: [`${key}.ts`],
    })

    if (await fsExists(`${tscFileName}.d.ts`)) {
      await fs.rm(`${tscFileName}.d.ts`)
    }
  }
}