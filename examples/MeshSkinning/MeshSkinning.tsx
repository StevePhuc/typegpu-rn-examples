import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Canvas } from 'react-native-wgpu';
import tgpu, { common } from 'typegpu';
import * as d from 'typegpu/data';
import * as std from 'typegpu/std';
import { mat4 } from 'wgpu-matrix';
import { useWebGPU } from '../../useWebGPU.ts';
import { createNodeTransformState, sampleAnimationInto } from './animation.ts';
import { loadGLBModel } from './loader.ts';
import { mat4ToDualQuat } from './math.ts';
import { generateTube } from './tube.ts';
import type { Animation, MeshData, ModelData, SceneVariant } from './types.ts';
import { VertexData } from './types.ts';

const MODEL_ASSET_URL =
  'https://docs.swmansion.com/TypeGPU/assets/mesh-skinning/DemoModel.glb';
const MODEL_ASSET = {
  scale: 1,
  offset: [0, 0, 0] as [number, number, number],
} as const;

const MAX_JOINTS = 128;
const INITIAL_CAMERA_POSITION = [3, 3, 3, 1] as const;
const CAMERA_TARGET_SMOOTHING = 0.08;
const CAMERA_TARGET_Y_OFFSET = 0.9;
const TWIST_DEMO_ID = 'Twist_Demo';
const DEMO_MATERIAL_ID = 0;
const LIGHTING = {
  key: d.vec3f(0.42, 0.84, 0.33),
  fill: d.vec3f(-0.8, 0.25, 0.55),
  specularColor: d.vec3f(1.0, 0.96, 0.9),
} as const;

function toLabel(id: string) {
  return id.replaceAll('_', ' ');
}

function calculatePos(
  target: [number, number, number],
  radius: number,
  pitch: number,
  yaw: number,
): [number, number, number] {
  const newX = radius * Math.sin(yaw) * Math.cos(pitch);
  const newY = radius * Math.sin(pitch);
  const newZ = radius * Math.cos(yaw) * Math.cos(pitch);
  return [target[0] + newX, target[1] + newY, target[2] + newZ];
}

export default function MeshSkinning() {
  const { width, height } = useWindowDimensions();
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [animations, setAnimations] = useState<string[]>([]);
  const [selectedAnimation, setSelectedAnimation] = useState('');
  const [isPlaying, setIsPlaying] = useState(true);
  const [useDualQuaternions, setUseDualQuaternions] = useState(false);

  // Mutable state ref shared with GPU loop to prevent restarting the useWebGPU hook
  const gpuStateRef = useRef({
    selectedAnimation: '',
    isPlaying: true,
    useDualQuaternions: false,
    timeSeconds: 0,
  });

  // Track state ref changes
  gpuStateRef.current.selectedAnimation = selectedAnimation;
  gpuStateRef.current.isPlaying = isPlaying;
  gpuStateRef.current.useDualQuaternions = useDualQuaternions;

  // Camera State
  const cameraStateRef = useRef({
    yaw: Math.atan2(3, 3),
    pitch: Math.asin(3 / Math.sqrt(27)),
    radius: Math.sqrt(27),
  });
  const cameraTargetRef = useRef<[number, number, number]>([0, 0.9, 0]);

  const baseYaw = useRef(0);
  const basePitch = useRef(0);
  const baseRadius = useRef(Math.sqrt(27));

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .maxPointers(1)
        .onBegin(() => {
          baseYaw.current = cameraStateRef.current.yaw;
          basePitch.current = cameraStateRef.current.pitch;
        })
        .onUpdate((e) => {
          const orbitSensitivity = 0.005;
          cameraStateRef.current.yaw =
            baseYaw.current - e.translationX * orbitSensitivity;
          cameraStateRef.current.pitch =
            basePitch.current + e.translationY * orbitSensitivity;
          // Clamp pitch to avoid turning camera upside down
          cameraStateRef.current.pitch = Math.max(
            -Math.PI / 2 + 0.05,
            Math.min(Math.PI / 2 - 0.05, cameraStateRef.current.pitch),
          );
        }),
    [],
  );

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onBegin(() => {
          baseRadius.current = cameraStateRef.current.radius;
        })
        .onUpdate((e) => {
          cameraStateRef.current.radius = baseRadius.current / e.scale;
          // Clamp radius to prevent clipping through model or zooming too far
          cameraStateRef.current.radius = Math.max(
            1.5,
            Math.min(15.0, cameraStateRef.current.radius),
          );
        }),
    [],
  );

  const combinedGesture = useMemo(
    () => Gesture.Simultaneous(panGesture, pinchGesture),
    [panGesture, pinchGesture],
  );

  const sceneFn = useMemo<Parameters<typeof useWebGPU>[0]>(() => {
    return async ({ context, device, presentationFormat }) => {
      const root = tgpu.initFromDevice({ device });

      let modelData: ModelData;
      try {
        modelData = await loadGLBModel(MODEL_ASSET_URL);
      } catch (err) {
        setLoadingError((err as Error)?.message || 'Failed to load model');
        setLoading(false);
        throw err;
      }

      const twistDemoMesh = generateTube(32, 8, 0.25, 2);

      const variants: SceneVariant[] = [
        ...modelData.animations.map((animation) => ({
          id: animation.name,
          mesh: modelData,
        })),
        {
          id: TWIST_DEMO_ID,
          mesh: twistDemoMesh,
        },
      ];

      const initialAnimList = variants.map((v) => v.id);
      setAnimations(initialAnimList);

      const defaultAnim =
        initialAnimList.find((id) => id === 'Yes') ??
        initialAnimList[0] ??
        TWIST_DEMO_ID;
      setSelectedAnimation(defaultAnim);
      gpuStateRef.current.selectedAnimation = defaultAnim;

      setLoading(false);

      if (modelData.jointNodes.length > MAX_JOINTS) {
        throw new Error(
          `Model has ${modelData.jointNodes.length} joints but MAX_JOINTS is ${MAX_JOINTS}.`,
        );
      }

      const parentByNode = new Int16Array(modelData.nodes.length).fill(-1);
      for (let parent = 0; parent < modelData.nodes.length; parent++) {
        for (const child of modelData.nodes[parent].children ?? []) {
          parentByNode[child] = parent;
        }
      }

      const inverseBindViews = modelData.jointNodes.map((_, index) =>
        modelData.inverseBindMatrices.subarray(index * 16, (index + 1) * 16),
      );

      const modelTransform = mat4.identity();
      mat4.translate(modelTransform, MODEL_ASSET.offset, modelTransform);
      mat4.scale(
        modelTransform,
        [MODEL_ASSET.scale, MODEL_ASSET.scale, MODEL_ASSET.scale],
        modelTransform,
      );

      const CpuState = {
        animatedTransforms: createNodeTransformState(modelData.nodes.length),
        animatedTransformIndices: [] as number[],
        nodeWorld: modelData.nodes.map(() => new Float32Array(16)),
        nodeWorldDirty: new Uint8Array(modelData.nodes.length),
        local: new Float32Array(16),
        quatMatrix: new Float32Array(16),
        jointWorld: modelData.jointNodes.map(() => new Float32Array(16)),
        jointMatrices: new Float32Array(MAX_JOINTS * 16),
        jointDualQuats: new Float32Array(MAX_JOINTS * 8),
        quatScratch: new Float32Array(4),
        rootJointPosition: new Float32Array(3),
        smoothedTarget: new Float32Array([0, CAMERA_TARGET_Y_OFFSET, 0]),
        cameraMatrix: new Float32Array(16),
      };

      for (
        let index = modelData.jointNodes.length;
        index < MAX_JOINTS;
        index++
      ) {
        mat4.identity(
          CpuState.jointMatrices.subarray(index * 16, index * 16 + 16),
        );
        CpuState.jointDualQuats[index * 8 + 3] = 1;
      }

      const canvasWidth = context.canvas.width;
      const canvasHeight = context.canvas.height;

      let lastWidth = canvasWidth || 1;
      let lastHeight = canvasHeight || 1;

      let depthTexture = device.createTexture({
        size: [lastWidth, lastHeight, 1],
        format: 'depth24plus',
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });

      let msaaTexture = device.createTexture({
        size: [lastWidth, lastHeight, 1],
        format: presentationFormat,
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });

      const materialPalette = [
        d.vec4f(0.82, 0.82, 0.82, 1),
        ...modelData.materials.map((material) => d.vec4f(...material)),
      ];

      const cameraUniform = root.createUniform(d.mat4x4f);
      const cameraPositionUniform = root.createUniform(
        d.vec4f,
        d.vec4f(...INITIAL_CAMERA_POSITION),
      );
      const materialUniform = root.createReadonly(
        d.arrayOf(d.vec4f, materialPalette.length),
        materialPalette,
      );
      const jointMatricesUniform = root.createUniform(
        d.arrayOf(d.mat4x4f, MAX_JOINTS),
        CpuState.jointMatrices,
      );
      const jointDualQuatsUniform = root.createUniform(
        d.arrayOf(d.vec4f, MAX_JOINTS * 2),
        CpuState.jointDualQuats,
      );

      function createRenderMesh(mesh: MeshData, materialIdOffset = 0) {
        const materialIds =
          materialIdOffset === 0
            ? mesh.materialIds
            : mesh.materialIds.map(
                (materialId) => materialId + materialIdOffset,
              );

        return {
          vertexBuffer: root
            .createBuffer(d.arrayOf(VertexData, mesh.vertexCount), (buffer) => {
              common.writeSoA(buffer, {
                position: mesh.positions,
                normal: mesh.normals,
                materialId: materialIds,
                joint: mesh.joints,
                weight: mesh.weights,
              });
            })
            .$usage('vertex'),
          indexBuffer: root
            .createBuffer(
              d.arrayOf(d.u16, mesh.indexCount),
              Array.from(mesh.indices),
            )
            .$usage('index'),
          indexCount: mesh.indexCount,
        };
      }

      const modelRenderMesh = createRenderMesh(modelData, 1);
      const demoRenderMesh = createRenderMesh(twistDemoMesh, DEMO_MATERIAL_ID);

      const vertexLayout = tgpu.vertexLayout(d.arrayOf(VertexData));

      const vertex = tgpu.vertexFn({
        in: {
          position: d.vec3f,
          normal: d.vec3f,
          materialId: d.u32,
          joint: d.vec4u,
          weight: d.vec4f,
        },
        out: {
          pos: d.builtin.position,
          normal: d.vec3f,
          color: d.vec3f,
          worldPos: d.vec3f,
        },
      })(({ position, normal, materialId, joint, weight }) => {
        'use gpu';
        const jointMatrices = jointMatricesUniform.$;
        const skinMatrix = std.add(
          std.add(
            std.add(
              std.mul(jointMatrices[joint.x], weight.x),
              std.mul(jointMatrices[joint.y], weight.y),
            ),
            std.mul(jointMatrices[joint.z], weight.z),
          ),
          std.mul(jointMatrices[joint.w], weight.w),
        );
        const skinnedPosition = std.mul(skinMatrix, d.vec4f(position, 1));

        return {
          pos: std.mul(cameraUniform.$, skinnedPosition),
          normal: std.normalize(std.mul(skinMatrix, d.vec4f(normal, 0)).xyz),
          color: materialUniform.$[materialId].xyz,
          worldPos: skinnedPosition.xyz,
        };
      });

      const rotateByUnitQuat = (value: d.v3f, quaternion: d.v4f): d.v3f => {
        'use gpu';
        const tangent = std.mul(2.0, std.cross(quaternion.xyz, value));
        return std.add(
          std.add(value, std.mul(quaternion.w, tangent)),
          std.cross(quaternion.xyz, tangent),
        );
      };

      const dqsVertex = tgpu.vertexFn({
        in: {
          position: d.vec3f,
          normal: d.vec3f,
          materialId: d.u32,
          joint: d.vec4u,
          weight: d.vec4f,
        },
        out: {
          pos: d.builtin.position,
          normal: d.vec3f,
          color: d.vec3f,
          worldPos: d.vec3f,
        },
      })(({ position, normal, materialId, joint, weight }) => {
        'use gpu';
        const dualQuats = jointDualQuatsUniform.$;
        const referenceReal = dualQuats[joint.x * 2];
        let realAccum = std.mul(referenceReal, weight.x);
        let dualAccum = std.mul(dualQuats[joint.x * 2 + 1], weight.x);

        for (const index of tgpu.unroll([1, 2, 3])) {
          const base = joint[index] * 2;
          const real = dualQuats[base];
          const signedWeight = std.mul(
            weight[index],
            std.select(d.f32(-1), 1, std.dot(referenceReal, real) >= 0),
          );
          realAccum = std.add(realAccum, std.mul(real, signedWeight));
          dualAccum = std.add(
            dualAccum,
            std.mul(dualQuats[base + 1], signedWeight),
          );
        }

        const invLength = 1 / std.length(realAccum);
        const real = std.mul(realAccum, invLength);
        const dual = std.mul(dualAccum, invLength);
        const translation = std.mul(
          2.0,
          std.add(
            std.sub(std.mul(real.w, dual.xyz), std.mul(dual.w, real.xyz)),
            std.cross(real.xyz, dual.xyz),
          ),
        );

        const worldPos = std.add(rotateByUnitQuat(position, real), translation);

        return {
          pos: std.mul(cameraUniform.$, d.vec4f(worldPos, 1)),
          normal: std.normalize(rotateByUnitQuat(normal, real)),
          color: materialUniform.$[materialId].xyz,
          worldPos,
        };
      });

      const fragment = tgpu.fragmentFn({
        in: { normal: d.vec3f, color: d.vec3f, worldPos: d.vec3f },
        out: d.vec4f,
      })(({ normal, color, worldPos }) => {
        'use gpu';
        const viewDir = std.normalize(
          std.sub(cameraPositionUniform.$.xyz, worldPos),
        );
        const key = std.saturate(std.dot(normal, LIGHTING.key));
        const fill = std.saturate(std.dot(normal, LIGHTING.fill));
        const halfVector = std.normalize(std.add(LIGHTING.key, viewDir));
        const specular = std.pow(std.saturate(std.dot(normal, halfVector)), 32);
        const finalColor = std.saturate(
          std.add(
            std.mul(color, 0.2 + key * 0.9 + fill * 0.25),
            std.mul(LIGHTING.specularColor, specular * 0.18),
          ),
        );

        return d.vec4f(finalColor, 1);
      });

      const pipelineConfig = {
        fragment,
        attribs: vertexLayout.attrib,
        depthStencil: {
          format: 'depth24plus' as const,
          depthWriteEnabled: true,
          depthCompare: 'less' as const,
        },
        multisample: { count: 4 },
      };

      const lbsPipeline = root.createRenderPipeline({
        vertex,
        ...pipelineConfig,
      });
      const dqsPipeline = root.createRenderPipeline({
        vertex: dqsVertex,
        ...pipelineConfig,
      });

      function getRootJointPosition(): Float32Array {
        mat4.getTranslation(CpuState.jointWorld[0], CpuState.rootJointPosition);
        return CpuState.rootJointPosition;
      }

      function updateCameraTarget(position: Float32Array) {
        const targetY = position[1] + CAMERA_TARGET_Y_OFFSET;
        CpuState.smoothedTarget[0] +=
          (position[0] - CpuState.smoothedTarget[0]) * CAMERA_TARGET_SMOOTHING;
        CpuState.smoothedTarget[1] +=
          (targetY - CpuState.smoothedTarget[1]) * CAMERA_TARGET_SMOOTHING;
        CpuState.smoothedTarget[2] +=
          (position[2] - CpuState.smoothedTarget[2]) * CAMERA_TARGET_SMOOTHING;

        cameraTargetRef.current = [
          CpuState.smoothedTarget[0],
          CpuState.smoothedTarget[1],
          CpuState.smoothedTarget[2],
        ];
      }

      function getAnimationById(id: string): Animation | undefined {
        return id === TWIST_DEMO_ID
          ? undefined
          : modelData.animations.find((animation) => animation.name === id);
      }

      function computeWorldTransform(
        nodeIndex: number,
        animatedTransforms: typeof CpuState.animatedTransforms,
      ): Float32Array {
        if (CpuState.nodeWorldDirty[nodeIndex]) {
          return CpuState.nodeWorld[nodeIndex];
        }

        const parentIndex = parentByNode[nodeIndex];
        const parentWorld =
          parentIndex === -1
            ? undefined
            : computeWorldTransform(parentIndex, animatedTransforms);
        const node = modelData.nodes[nodeIndex];
        const animated = animatedTransforms[nodeIndex];

        mat4.identity(CpuState.local);
        if (animated.hasTranslation || node.translation) {
          mat4.translate(
            CpuState.local,
            animated.hasTranslation
              ? animated.translation
              : (node.translation ?? [0, 0, 0]),
            CpuState.local,
          );
        }
        if (animated.hasRotation || node.rotation) {
          mat4.mul(
            CpuState.local,
            mat4.fromQuat(
              animated.hasRotation
                ? animated.rotation
                : (node.rotation ?? [0, 0, 0, 1]),
              CpuState.quatMatrix,
            ),
            CpuState.local,
          );
        }
        if (animated.hasScale || node.scale) {
          mat4.scale(
            CpuState.local,
            animated.hasScale ? animated.scale : (node.scale ?? [1, 1, 1]),
            CpuState.local,
          );
        }

        const destination = CpuState.nodeWorld[nodeIndex];
        if (parentWorld) {
          mat4.mul(parentWorld, CpuState.local, destination);
        } else {
          destination.set(CpuState.local);
        }

        CpuState.nodeWorldDirty[nodeIndex] = 1;
        return destination;
      }

      function writeJointDualQuat(jointIndex: number) {
        const matrixOffset = jointIndex * 16;
        mat4ToDualQuat(
          CpuState.jointMatrices.subarray(matrixOffset, matrixOffset + 16),
          CpuState.quatScratch,
          CpuState.jointDualQuats,
          jointIndex * 8,
        );
      }

      function updateModelSkinning(activeAnimation: Animation | undefined) {
        const animatedTransforms = sampleAnimationInto(
          activeAnimation,
          gpuStateRef.current.timeSeconds,
          CpuState.animatedTransforms,
          CpuState.animatedTransformIndices,
        );

        CpuState.nodeWorldDirty.fill(0);
        for (
          let jointIndex = 0;
          jointIndex < modelData.jointNodes.length;
          jointIndex++
        ) {
          const world = computeWorldTransform(
            modelData.jointNodes[jointIndex],
            animatedTransforms,
          );
          mat4.mul(modelTransform, world, CpuState.jointWorld[jointIndex]);

          const matrixOffset = jointIndex * 16;
          mat4.mul(
            CpuState.jointWorld[jointIndex],
            inverseBindViews[jointIndex],
            CpuState.jointMatrices.subarray(matrixOffset, matrixOffset + 16),
          );
          writeJointDualQuat(jointIndex);
        }

        updateCameraTarget(getRootJointPosition());
      }

      function updateTwistDemo() {
        const twist = Math.sin(gpuStateRef.current.timeSeconds * 0.5) * Math.PI;

        mat4.identity(CpuState.jointMatrices.subarray(0, 16));
        CpuState.quatScratch.set([
          0,
          Math.sin(twist / 2),
          0,
          Math.cos(twist / 2),
        ]);
        mat4.fromQuat(
          CpuState.quatScratch,
          CpuState.jointMatrices.subarray(16, 32),
        );

        writeJointDualQuat(0);
        writeJointDualQuat(1);
        for (
          let jointIndex = 2;
          jointIndex < modelData.jointNodes.length;
          jointIndex++
        ) {
          const matrixOffset = jointIndex * 16;
          mat4.identity(
            CpuState.jointMatrices.subarray(matrixOffset, matrixOffset + 16),
          );
          CpuState.jointDualQuats.fill(0, jointIndex * 8, jointIndex * 8 + 8);
          CpuState.jointDualQuats[jointIndex * 8 + 3] = 1;
        }

        cameraTargetRef.current = [0, 0, 0];
      }

      let lastFrameTimeMs = Date.now();
      let lastLoggedRadius = 0;

      function render(timestamp: number) {
        const activeAnimId = gpuStateRef.current.selectedAnimation;
        const activeVariant = variants.find((v) => v.id === activeAnimId);
        const activeAnimation = getAnimationById(activeAnimId);

        const deltaTimeMs = Math.max(0, timestamp - lastFrameTimeMs);
        lastFrameTimeMs = timestamp;

        // Recreate depth/msaa textures dynamically on canvas layout/size changes
        const currentWidth = context.canvas.width;
        const currentHeight = context.canvas.height;
        if (
          (currentWidth !== lastWidth || currentHeight !== lastHeight) &&
          currentWidth > 0 &&
          currentHeight > 0
        ) {
          depthTexture.destroy();
          msaaTexture.destroy();

          depthTexture = device.createTexture({
            size: [currentWidth, currentHeight, 1],
            format: 'depth24plus',
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });

          msaaTexture = device.createTexture({
            size: [currentWidth, currentHeight, 1],
            format: presentationFormat,
            sampleCount: 4,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });

          lastWidth = currentWidth;
          lastHeight = currentHeight;
        }

        if (gpuStateRef.current.isPlaying) {
          gpuStateRef.current.timeSeconds += deltaTimeMs * 0.001;
        }

        if (activeAnimId === TWIST_DEMO_ID) {
          updateTwistDemo();
        } else {
          updateModelSkinning(activeAnimation);
        }

        // Update camera view/projection matrix
        const cameraState = cameraStateRef.current;
        if (Math.abs(cameraState.radius - lastLoggedRadius) > 0.01) {
          console.log(
            '[Camera Zoom] radius changed from',
            lastLoggedRadius.toFixed(2),
            'to',
            cameraState.radius.toFixed(2),
          );
          lastLoggedRadius = cameraState.radius;
        }
        const camPos = calculatePos(
          cameraTargetRef.current,
          cameraState.radius,
          cameraState.pitch,
          cameraState.yaw,
        );

        const view = mat4.lookAt(camPos, cameraTargetRef.current, [0, 1, 0]);
        const projection = mat4.perspective(
          Math.PI / 4,
          lastWidth / lastHeight,
          0.1,
          1000,
        );
        const viewProj = mat4.mul(projection, view);

        cameraUniform.write(viewProj);
        cameraPositionUniform.write(
          d.vec4f(camPos[0], camPos[1], camPos[2], 1),
        );

        // Draw
        jointMatricesUniform.write(CpuState.jointMatrices);
        jointDualQuatsUniform.write(CpuState.jointDualQuats);

        const renderMesh =
          activeAnimId === TWIST_DEMO_ID ? demoRenderMesh : modelRenderMesh;
        const pipeline = gpuStateRef.current.useDualQuaternions
          ? dqsPipeline
          : lbsPipeline;

        pipeline
          .with(vertexLayout, renderMesh.vertexBuffer)
          .withIndexBuffer(renderMesh.indexBuffer)
          .withColorAttachment({
            view: msaaTexture.createView(),
            resolveTarget: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0.93, 0.93, 0.96, 1.0], // sleek premium grey
          })
          .withDepthStencilAttachment({
            view: depthTexture.createView(),
            depthClearValue: 1,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          })
          .drawIndexed(renderMesh.indexCount);
      }

      return render;
    };
  }, []);

  const ref = useWebGPU(sceneFn);

  if (loadingError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: 'red', fontSize: 16, textAlign: 'center' }}>
          Error: {loadingError}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, width: '100%', backgroundColor: '#1E293B' }}>
      {loading ? (
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 10,
          }}
        >
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text style={{ color: 'white', marginTop: 10, fontSize: 16 }}>
            Loading GLB model...
          </Text>
        </View>
      ) : null}

      <View
        style={{
          width: width > height ? undefined : '100%',
          height: width > height ? '100%' : undefined,
          aspectRatio: 1,
          position: 'relative',
        }}
      >
        <GestureDetector gesture={combinedGesture}>
          <Canvas
            ref={ref}
            style={{
              flex: 1,
              backgroundColor: '#1E293B',
            }}
          />
        </GestureDetector>

        {/* Floating Zoom HUD Overlay */}
        <View
          style={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            flexDirection: 'row',
            backgroundColor: 'rgba(15, 23, 42, 0.85)',
            borderRadius: 24,
            padding: 6,
            gap: 6,
            borderWidth: 1,
            borderColor: 'rgba(51, 65, 85, 0.6)',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 4,
            elevation: 5,
          }}
        >
          <Pressable
            onPress={() => {
              cameraStateRef.current.radius = Math.max(
                1.5,
                cameraStateRef.current.radius - 0.5,
              );
            }}
            style={({ pressed }) => ({
              backgroundColor: pressed ? '#3B82F6' : '#1E293B',
              width: 38,
              height: 38,
              borderRadius: 19,
              justifyContent: 'center',
              alignItems: 'center',
              borderWidth: 1,
              borderColor: '#334155',
            })}
          >
            <Text style={{ color: 'white', fontSize: 20, fontWeight: 'bold' }}>
              +
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              cameraStateRef.current.radius = Math.min(
                15.0,
                cameraStateRef.current.radius + 0.5,
              );
            }}
            style={({ pressed }) => ({
              backgroundColor: pressed ? '#3B82F6' : '#1E293B',
              width: 38,
              height: 38,
              borderRadius: 19,
              justifyContent: 'center',
              alignItems: 'center',
              borderWidth: 1,
              borderColor: '#334155',
            })}
          >
            <Text style={{ color: 'white', fontSize: 20, fontWeight: 'bold' }}>
              -
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              cameraStateRef.current.radius = Math.sqrt(27);
              cameraStateRef.current.yaw = Math.atan2(3, 3);
              cameraStateRef.current.pitch = Math.asin(3 / Math.sqrt(27));
            }}
            style={({ pressed }) => ({
              backgroundColor: pressed ? '#3B82F6' : '#1E293B',
              width: 38,
              height: 38,
              borderRadius: 19,
              justifyContent: 'center',
              alignItems: 'center',
              borderWidth: 1,
              borderColor: '#334155',
            })}
          >
            <Text style={{ color: 'white', fontSize: 16 }}>⟲</Text>
          </Pressable>
        </View>
      </View>

      {/* Control panel */}
      <View
        style={{
          flex: 1,
          padding: 16,
          backgroundColor: '#0F172A',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
        }}
      >
        <Text
          style={{
            color: 'white',
            fontSize: 20,
            fontWeight: 'bold',
            marginBottom: 12,
          }}
        >
          Mesh Skinning Controls
        </Text>

        <Text style={{ color: '#94A3B8', fontSize: 14, marginBottom: 6 }}>
          Select Animation
        </Text>

        <View style={{ height: 44, marginBottom: 16 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {animations.map((animName) => {
              const active = selectedAnimation === animName;
              return (
                <Pressable
                  key={animName}
                  onPress={() => setSelectedAnimation(animName)}
                  style={{
                    backgroundColor: active ? '#2563EB' : '#334155',
                    paddingHorizontal: 16,
                    paddingVertical: 10,
                    borderRadius: 20,
                    marginRight: 10,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      color: 'white',
                      fontWeight: active ? 'bold' : 'normal',
                    }}
                  >
                    {toLabel(animName)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <Text style={{ color: 'white', fontSize: 16 }}>
            Skinning Algorithm
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable
              onPress={() => setUseDualQuaternions(false)}
              style={{
                backgroundColor: !useDualQuaternions ? '#2563EB' : '#334155',
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: 'white', fontWeight: 'bold' }}>LBS</Text>
            </Pressable>
            <Pressable
              onPress={() => setUseDualQuaternions(true)}
              style={{
                backgroundColor: useDualQuaternions ? '#2563EB' : '#334155',
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: 'white', fontWeight: 'bold' }}>DQS</Text>
            </Pressable>
          </View>
        </View>

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
          }}
        >
          <Pressable
            onPress={() => setIsPlaying(!isPlaying)}
            style={{
              flex: 1,
              backgroundColor: '#1E293B',
              paddingVertical: 12,
              borderRadius: 10,
              marginRight: 8,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: '#334155',
            }}
          >
            <Text style={{ color: 'white', fontWeight: 'bold' }}>
              {isPlaying ? 'Pause Animation' : 'Play Animation'}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              gpuStateRef.current.timeSeconds = 0;
            }}
            style={{
              flex: 1,
              backgroundColor: '#1E293B',
              paddingVertical: 12,
              borderRadius: 10,
              marginLeft: 8,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: '#334155',
            }}
          >
            <Text style={{ color: 'white', fontWeight: 'bold' }}>
              Reset Time
            </Text>
          </Pressable>
        </View>

        <Text
          style={{
            color: '#64748B',
            fontSize: 12,
            textAlign: 'center',
            marginTop: 10,
          }}
        >
          Drag to orbit. Pinch or use floating overlay buttons (+ / - / ⟲) to
          zoom and reset camera view.
        </Text>
      </View>
    </View>
  );
}
