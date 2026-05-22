import { useRoot } from "@typegpu/react";
import { useEffect, useRef, useState } from "react";
import { createShareable, scheduleOnUI, UIRuntimeId } from "react-native-worklets";

import { d, type TgpuRoot } from "typegpu";
import { tgpu } from "typegpu";

// interface SharedState {
//   pendingDevice: Promise<GPUDevice> | undefined;
// }

// interface RuntimeLocalState {
//   root: TgpuRoot | undefined;
// }

// const sharedState: SharedState = {
//   pendingDevice: undefined,
// };

// const rnLocals: RuntimeLocalState = {
//   root: undefined,
// };

// const uiLocals = createShareable<number, RuntimeLocalState>(UIRuntimeId, 0, {
//   hostDecorator: (value) => {
//     "worklet";
//     value.root = undefined;
//     return value;
//   },
// });

// registerCustomSerializable({
//   name: "typegpu.NonCallableSchema",
//   determine: (value): value is d.AnyWgslData => {
//     "worklet";
//     return (
//       d.isWgslData(value) &&
//       (value as d.AnyWgslData).type !== "array" &&
//       (value as d.AnyWgslData).type !== "struct" &&
//       (value as d.AnyWgslData).type !== "decorated"
//     );
//   },
//   pack: (value) => {
//     "worklet";
//     if (value.type === "vec2<bool>") {
//       return { type: "vec2b" as const };
//     }
//     if (value.type === "vec3<bool>") {
//       return { type: "vec3b" as const };
//     }
//     if (value.type === "vec4<bool>") {
//       return { type: "vec4b" as const };
//     }
//     return { type: value.type };
//   },
//   unpack: (value) => {
//     "worklet";
//     return d[value.type as keyof typeof d] as d.AnyWgslData;
//   },
// });

// registerCustomSerializable({
//   name: "typegpu.WgslArray",
//   determine: (value): value is d.WgslArray => {
//     "worklet";
//     return d.isWgslData(value) && (value as d.WgslArray).type === "array";
//   },
//   pack: (value) => {
//     "worklet";
//     return { elementType: value.elementType as d.AnyWgslData, elementCount: value.elementCount };
//   },
//   unpack: (value) => {
//     "worklet";
//     return d.arrayOf(value.elementType, value.elementCount);
//   },
// });

// registerCustomSerializable({
//   name: "typegpu.WgslStruct",
//   determine: (value): value is d.WgslStruct => {
//     "worklet";
//     return d.isWgslData(value) && (value as d.WgslStruct).type === "struct";
//   },
//   pack: (value) => {
//     "worklet";
//     console.log("Serializing struct: ", value);
//     return { props: value.propTypes as Record<string, d.AnyWgslData> };
//   },
//   unpack: (value) => {
//     "worklet";
//     console.log("Deserializing struct: ", value);
//     return d.struct(value.props);
//   },
// });

// registerCustomSerializable({
//   name: "typegpu.TgpuRoot",
//   determine: (value): value is TgpuRoot => {
//     "worklet";
//     // I think it's the most unique method on roots
//     return typeof (value as TgpuRoot).createGuardedComputePipeline === "function";
//   },
//   pack: (value) => {
//     "worklet";
//     console.log("Serializing root: ", value);
//     console.log("Device: ", value.device);
//     console.log("Is device serializable: ", isSerializableRef(value.device));

//     return {
//       device: value.device,
//       // TODO: Serialize more fields
//     };
//   },
//   unpack: (value) => {
//     "worklet";
//     console.log("Deserializing root: ", value);

//     // try {
//     //   typegpu.tgpu.initFromDevice({ device: value.device });
//     // } catch (e) {
//     //   console.log(e);
//     // }
//     return {} as TgpuRoot;
//   },
// });

export function useRootUI(): TgpuRoot {
  const root = useRoot();
  const device = root.device;

  const [fakeState] = useState(() => {
    const shareable = createShareable<number, TgpuRoot, TgpuRoot>(UIRuntimeId, 0, {
      hostDecorator: (value) => {
        "worklet";
        const realRoot = tgpu.initFromDevice({ device });
        Object.setPrototypeOf(value, Object.getPrototypeOf(realRoot));
        Object.defineProperties(value, {
          device: {
            get: () => realRoot.device,
          },
          enabledFeatures: {
            get: () => realRoot.enabledFeatures,
          },
          "~unstable": {
            get: () => realRoot["~unstable"],
          },
          configureContext: {
            get: () => realRoot.configureContext.bind(realRoot),
          },
          createBindGroup: {
            get: () => realRoot.createBindGroup.bind(realRoot),
          },
          createBuffer: {
            get: () => realRoot.createBuffer.bind(realRoot),
          },
          createComputePipeline: {
            get: () => realRoot.createComputePipeline.bind(realRoot),
          },
          createGuardedComputePipeline: {
            get: () => realRoot.createGuardedComputePipeline.bind(realRoot),
          },
          createMutable: {
            get: () => realRoot.createMutable.bind(realRoot),
          },
          createQuerySet: {
            get: () => realRoot.createQuerySet.bind(realRoot),
          },
          createReadonly: {
            get: () => realRoot.createReadonly.bind(realRoot),
          },
          createRenderPipeline: {
            get: () => realRoot.createRenderPipeline.bind(realRoot),
          },
          createUniform: {
            get: () => realRoot.createUniform.bind(realRoot),
          },
          destroy: {
            get: () => realRoot.destroy.bind(realRoot),
          },
          pipe: {
            get: () => realRoot.pipe.bind(realRoot),
          },
          with: {
            get: () => realRoot.with.bind(realRoot),
          },
        });

        return value;
      },
      guestDecorator: (value) => {
        "worklet";
        const realRoot = tgpu.initFromDevice({ device });
        Object.setPrototypeOf(value, Object.getPrototypeOf(realRoot));
        Object.defineProperties(value, {
          device: {
            get: () => realRoot.device,
          },
          enabledFeatures: {
            get: () => realRoot.enabledFeatures,
          },
          "~unstable": {
            get: () => realRoot["~unstable"],
          },
          configureContext: {
            get: () => realRoot.configureContext.bind(realRoot),
          },
          createBindGroup: {
            get: () => realRoot.createBindGroup.bind(realRoot),
          },
          createBuffer: {
            get: () => realRoot.createBuffer.bind(realRoot),
          },
          createComputePipeline: {
            get: () => realRoot.createComputePipeline.bind(realRoot),
          },
          createGuardedComputePipeline: {
            get: () => realRoot.createGuardedComputePipeline.bind(realRoot),
          },
          createMutable: {
            get: () => realRoot.createMutable.bind(realRoot),
          },
          createQuerySet: {
            get: () => realRoot.createQuerySet.bind(realRoot),
          },
          createReadonly: {
            get: () => realRoot.createReadonly.bind(realRoot),
          },
          createRenderPipeline: {
            get: () => realRoot.createRenderPipeline.bind(realRoot),
          },
          createUniform: {
            get: () => realRoot.createUniform.bind(realRoot),
          },
          destroy: {
            get: () => realRoot.destroy.bind(realRoot),
          },
          pipe: {
            get: () => realRoot.pipe.bind(realRoot),
          },
          with: {
            get: () => realRoot.with.bind(realRoot),
          },
        });

        return value;
      },
    });

    return {
      shareable,
    };
  });

  return fakeState.shareable;
}

// TODO: Allow schemas to be passed in
// function useUniform<TData extends d.AnyWgslData>(): TgpuUniform<TData> {
//   // use(rnGlobals);
//   // use(
//   //   (resultPromise ??= runOnUIAsync(async () => {
//   //     uiGlobals.root = await tgpu.init();
//   //   })),
//   // );

//   const [fakeState] = useState(() => {
//     const shareable = createShareable<number, TgpuUniform<TData>, TgpuUniform<TData>>(
//       UIRuntimeId,
//       0,
//       {
//         hostDecorator: (value) => {
//           const realUniform = uiGlobals.root!.createUniform(d.f32);
//           Object.setPrototypeOf(value, Object.getPrototypeOf(realUniform));
//           Object.defineProperties(value, {
//             $: {
//               get: () => realUniform.$,
//             },
//             $name: {
//               get: () => realUniform.$name,
//             },
//             buffer: {
//               get: () => realUniform.buffer,
//             },
//             read: {
//               get: () => realUniform.read,
//             },
//             resourceType: {
//               get: () => realUniform.resourceType,
//             },
//             write: {
//               get: () => realUniform.write,
//             },
//             writePartial: {
//               get: () => realUniform.writePartial,
//             },
//           });
//           return value;
//         },
//         guestDecorator: (value) => {
//           return value;
//         },
//       },
//     );
//     return {
//       shareable,
//     };
//   });

//   return fakeState.shareable;
// }

export function useFrameUI(cb: (timestep: number) => void) {
  const prevCb = useRef(cb);
  const [shareable] = useState(() => {
    return createShareable<undefined, { cb: (timestep: number) => void }>(UIRuntimeId, undefined, {
      hostDecorator: (value) => {
        "worklet";
        value.cb = cb;
        return value;
      },
    });
  });
  if (cb !== prevCb.current) {
    scheduleOnUI(() => {
      shareable.cb = cb;
    });
    prevCb.current = cb;
  }

  useEffect(() => {
    const rafShareable = createShareable<number | undefined>(UIRuntimeId, undefined);

    scheduleOnUI(() => {
      let startTime: number | undefined;
      const frame = (timestep: number) => {
        if (startTime === undefined) {
          startTime = timestep;
        }
        const elapsedSeconds = (timestep - startTime) / 1000;
        shareable.cb!(elapsedSeconds);
        rafShareable.value = requestAnimationFrame(frame);
      };

      rafShareable.value = requestAnimationFrame(frame);
    });

    return () => {
      scheduleOnUI(() => {
        if (rafShareable.value) {
          cancelAnimationFrame(rafShareable.value);
          rafShareable.value = undefined;
        }
      });
    };
  }, []);
}
