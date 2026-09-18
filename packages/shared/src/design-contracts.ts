import { z } from "zod";

// This is Loomic's durable protocol, not a Fabric JSON dump. All persisted
// fields are explicitly allowed here so engine-private and authorization data
// cannot leak into scenes or commands.

export const designUuidSchema = z.string().uuid();
const finiteNumberSchema = z.number().finite();
const positiveFiniteNumberSchema = finiteNumberSchema.positive();
export const designDimensionSchema = z.number().int().min(1).max(32_768);
const colorSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.string().datetime({ offset: true });

export const designColorStopSchema = z
  .object({
    offset: z.number().finite().min(0).max(1),
    color: colorSchema,
  })
  .strict();

const gradientStopsSchema = z
  .array(designColorStopSchema)
  .min(2)
  .max(32)
  .superRefine((stops, context) => {
    for (let index = 1; index < stops.length; index += 1) {
      const previous = stops[index - 1];
      const current = stops[index];
      if (!previous || !current || current.offset <= previous.offset) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "gradient stop offsets must be strictly increasing",
          path: [index, "offset"],
        });
      }
    }
  });

export const designSolidPaintSchema = z
  .object({ kind: z.literal("solid"), color: colorSchema })
  .strict();
export const designLinearPaintSchema = z
  .object({
    kind: z.literal("linear"),
    angle: finiteNumberSchema,
    stops: gradientStopsSchema,
  })
  .strict();
export const designRadialPaintSchema = z
  .object({
    kind: z.literal("radial"),
    centerX: z.number().finite().min(0).max(1),
    centerY: z.number().finite().min(0).max(1),
    radius: z.number().finite().positive().max(2),
    stops: gradientStopsSchema,
  })
  .strict();
export const designPaintSchema = z.discriminatedUnion("kind", [
  designSolidPaintSchema,
  designLinearPaintSchema,
  designRadialPaintSchema,
]);
export type DesignPaint = z.infer<typeof designPaintSchema>;

export const designShadowSchema = z
  .object({
    color: colorSchema,
    blur: z.number().finite().nonnegative(),
    offsetX: finiteNumberSchema,
    offsetY: finiteNumberSchema,
    opacity: z.number().finite().min(0).max(1),
  })
  .strict();
export type DesignShadow = z.infer<typeof designShadowSchema>;

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
) {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "values must be unique",
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}

const uniqueUuidArraySchema = z
  .array(designUuidSchema)
  .superRefine((values, context) => addDuplicateIssues(values, context, []));
const nonEmptyUniqueUuidArraySchema = z
  .array(designUuidSchema)
  .min(1)
  .superRefine((values, context) => addDuplicateIssues(values, context, []));

export const designObjectTypeSchema = z.enum([
  "image",
  "svg",
  "text",
  "textbox",
  "rect",
  "circle",
  "triangle",
  "line",
  "arrow",
  "group",
]);
export type DesignObjectType = z.infer<typeof designObjectTypeSchema>;

export const designObjectRoleSchema = z.enum([
  "background",
  "title",
  "subtitle",
  "logo",
  "product",
  "decoration",
]);
export type DesignObjectRole = z.infer<typeof designObjectRoleSchema>;

export const designObjectAnimationSchema = z.object({
  type: z.enum(["float", "scale"]),
  durationMs: finiteNumberSchema.min(500).max(10000),
  amount: finiteNumberSchema.min(1).max(100),
}).strict();
export type DesignObjectAnimation = z.infer<typeof designObjectAnimationSchema>;

const designObjectBaseShape = {
  animation: designObjectAnimationSchema.nullable().optional(),
  objectId: designUuidSchema,
  objectVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: positiveFiniteNumberSchema,
  height: positiveFiniteNumberSchema,
  rotation: finiteNumberSchema,
  opacity: finiteNumberSchema.min(0).max(1),
  zIndex: z.number().int().nonnegative(),
  locked: z.boolean(),
  visible: z.boolean(),
  role: designObjectRoleSchema.nullable().optional(),
} as const;

export const designImageFitSchema = z.enum([
  "contain",
  "cover",
  "fill",
  "original",
]);

const normalizedUnitSchema = finiteNumberSchema.min(0).max(1);

export const designImageCropSchema = z
  .object({
    x: normalizedUnitSchema,
    y: normalizedUnitSchema,
    width: positiveFiniteNumberSchema.max(1),
    height: positiveFiniteNumberSchema.max(1),
  })
  .strict()
  .superRefine((crop, context) => {
    if (crop.x + crop.width > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "crop exceeds the source right edge",
        path: ["width"],
      });
    }
    if (crop.y + crop.height > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "crop exceeds the source bottom edge",
        path: ["height"],
      });
    }
  });
export type DesignImageCrop = z.infer<typeof designImageCropSchema>;

export const designImageMaskSchema = z
  .object({
    shape: z.enum(["rect", "ellipse", "rounded_rect"]),
    x: normalizedUnitSchema,
    y: normalizedUnitSchema,
    width: positiveFiniteNumberSchema.max(1),
    height: positiveFiniteNumberSchema.max(1),
    radius: normalizedUnitSchema.max(0.5).optional(),
  })
  .strict()
  .superRefine((mask, context) => {
    if (mask.x + mask.width > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mask exceeds the destination right edge",
        path: ["width"],
      });
    }
    if (mask.y + mask.height > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mask exceeds the destination bottom edge",
        path: ["height"],
      });
    }
    if (mask.shape !== "rounded_rect" && mask.radius !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "radius is only valid for a rounded rectangle mask",
        path: ["radius"],
      });
    }
  });
export type DesignImageMask = z.infer<typeof designImageMaskSchema>;

export const designImageFiltersSchema = z
  .object({
    brightness: finiteNumberSchema.min(-1).max(1).optional(),
    contrast: finiteNumberSchema.min(-1).max(1).optional(),
    saturation: finiteNumberSchema.min(-1).max(1).optional(),
    blur: normalizedUnitSchema.optional(),
    grayscale: z.boolean().optional(),
    sepia: z.boolean().optional(),
  })
  .strict()
  .refine((filters) => Object.keys(filters).length > 0, {
    message: "filters must not be empty",
  });
export type DesignImageFilters = z.infer<typeof designImageFiltersSchema>;

export const designImageObjectSchema = z
  .object({
    ...designObjectBaseShape,
    type: z.literal("image"),
    assetObjectId: designUuidSchema,
    resourceId: designUuidSchema.nullable().optional(),
    fit: designImageFitSchema,
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    crop: designImageCropSchema.nullable().optional(),
    mask: designImageMaskSchema.nullable().optional(),
    filters: designImageFiltersSchema.nullable().optional(),
    stroke: designPaintSchema.nullable().optional(),
    strokeWidth: finiteNumberSchema.nonnegative().optional(),
    shadow: designShadowSchema.nullable().optional(),
  })
  .strict();

export const designSvgObjectSchema = z
  .object({
    ...designObjectBaseShape,
    type: z.literal("svg"),
    assetObjectId: designUuidSchema,
    resourceId: designUuidSchema.nullable().optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
  })
  .strict();

const textShape = {
  paintFirst: z.enum(["fill", "stroke"]).optional(),
  splitByGrapheme: z.boolean().optional(),
  text: z.string().max(100_000),
  fontFaceId: designUuidSchema.nullable().optional(),
  fontFamily: z.string().trim().min(1).max(200),
  fontSize: positiveFiniteNumberSchema,
  fontWeight: z.union([
    z.number().int().min(1).max(1_000),
    z.string().trim().min(1).max(50),
  ]),
  fontStyle: z.enum(["normal", "italic", "oblique"]),
  textAlign: z.enum(["left", "center", "right", "justify"]),
  lineHeight: positiveFiniteNumberSchema,
  charSpacing: finiteNumberSchema,
  fill: designPaintSchema,
  stroke: designPaintSchema.nullable().optional(),
  strokeWidth: finiteNumberSchema.nonnegative().optional(),
  shadow: designShadowSchema.nullable().optional(),
} as const;

export const designTextObjectSchema = z
  .object({ ...designObjectBaseShape, type: z.literal("text"), ...textShape })
  .strict();

export const designTextboxObjectSchema = z
  .object({
    ...designObjectBaseShape,
    type: z.literal("textbox"),
    ...textShape,
    minWidth: positiveFiniteNumberSchema.optional(),
  })
  .strict();

const shapeStyle = {
  fill: designPaintSchema.nullable(),
  stroke: designPaintSchema.nullable(),
  strokeWidth: finiteNumberSchema.nonnegative(),
  shadow: designShadowSchema.nullable().optional(),
} as const;

export const designRectObjectSchema = z
  .object({
    ...designObjectBaseShape,
    type: z.literal("rect"),
    ...shapeStyle,
    radiusX: finiteNumberSchema.nonnegative().optional(),
    radiusY: finiteNumberSchema.nonnegative().optional(),
  })
  .strict();

export const designCircleObjectSchema = z
  .object({
    ...designObjectBaseShape,
    type: z.literal("circle"),
    ...shapeStyle,
  })
  .strict();

export const designTriangleObjectSchema = z
  .object({
    ...designObjectBaseShape,
    type: z.literal("triangle"),
    ...shapeStyle,
  })
  .strict();

const lineShape = {
  stroke: designPaintSchema,
  strokeWidth: finiteNumberSchema.nonnegative(),
  x1: finiteNumberSchema,
  y1: finiteNumberSchema,
  x2: finiteNumberSchema,
  y2: finiteNumberSchema,
} as const;

export const designLineObjectSchema = z
  .object({ ...designObjectBaseShape, type: z.literal("line"), ...lineShape })
  .strict();

export const designArrowObjectSchema = z
  .object({
    ...designObjectBaseShape,
    type: z.literal("arrow"),
    ...lineShape,
    arrowStart: z.enum(["none", "arrow"]).optional(),
    arrowEnd: z.enum(["none", "arrow"]),
  })
  .strict();

export const designGroupObjectSchema = z
  .object({
    ...designObjectBaseShape,
    type: z.literal("group"),
    childObjectIds: nonEmptyUniqueUuidArraySchema,
  })
  .strict();

export const designObjectSchema = z.discriminatedUnion("type", [
  designImageObjectSchema,
  designSvgObjectSchema,
  designTextObjectSchema,
  designTextboxObjectSchema,
  designRectObjectSchema,
  designCircleObjectSchema,
  designTriangleObjectSchema,
  designLineObjectSchema,
  designArrowObjectSchema,
  designGroupObjectSchema,
]);
export type DesignObject = z.infer<typeof designObjectSchema>;

export const newDesignObjectSchema = designObjectSchema.refine(
  (object) => object.objectVersion === 1,
  {
    message: "new objects must start at objectVersion 1",
    path: ["objectVersion"],
  },
);
export type NewDesignObject = z.infer<typeof newDesignObjectSchema>;

export const loomicSceneV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    engine: z.literal("fabric"),
    canvas: z
      .object({
        width: designDimensionSchema,
        height: designDimensionSchema,
        background: colorSchema.nullable(),
      })
      .strict(),
    objects: z.array(designObjectSchema).max(10_000),
  })
  .strict()
  .superRefine((scene, context) => {
    const objectIds = scene.objects.map((object) => object.objectId);
    addDuplicateIssues(objectIds, context, ["objects"]);
    const ids = new Set(objectIds);
    const groups = new Map<string, readonly string[]>();
    const parentByChild = new Map<string, string>();

    for (const [index, object] of scene.objects.entries()) {
      if (object.zIndex !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "object zIndex must match its zero-based array index",
          path: ["objects", index, "zIndex"],
        });
      }
      if (object.type !== "group") continue;
      groups.set(object.objectId, object.childObjectIds);
      for (const [childIndex, childId] of object.childObjectIds.entries()) {
        if (childId === object.objectId || !ids.has(childId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "group children must reference another object in the scene",
            path: ["objects", index, "childObjectIds", childIndex],
          });
        }
        const currentParent = parentByChild.get(childId);
        if (currentParent && currentParent !== object.objectId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "an object may belong to only one group",
            path: ["objects", index, "childObjectIds", childIndex],
          });
        } else {
          parentByChild.set(childId, object.objectId);
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (groupId: string): boolean => {
      if (visiting.has(groupId)) return true;
      if (visited.has(groupId)) return false;
      visiting.add(groupId);
      for (const childId of groups.get(groupId) ?? []) {
        if (groups.has(childId) && visit(childId)) return true;
      }
      visiting.delete(groupId);
      visited.add(groupId);
      return false;
    };
    for (const [groupId] of groups) {
      if (visit(groupId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "groups must not contain cycles",
          path: ["objects"],
        });
        break;
      }
    }
  });
export type LoomicSceneV1 = z.infer<typeof loomicSceneV1Schema>;

function validatePreviewState(
  value: {
    revision: number;
    previewAssetObjectId?: string | null;
    previewRevision?: number;
  },
  context: z.RefinementCtx,
) {
  if (
    value.previewRevision !== undefined &&
    value.previewRevision > value.revision
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "preview revision cannot exceed document revision",
      path: ["previewRevision"],
    });
  }
  if (value.previewAssetObjectId === null && value.previewRevision !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a missing preview asset requires preview revision 0",
      path: ["previewRevision"],
    });
  }
  if (
    value.previewAssetObjectId === undefined &&
    value.previewRevision !== undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "preview asset and revision must be supplied together",
      path: ["previewAssetObjectId"],
    });
  }
}

export const loomicDesignNodeMetadataSchema = z
  .object({
    kind: z.literal("loomic-design"),
    schemaVersion: z.literal(1),
    designId: designUuidSchema,
    revision: z.number().int().nonnegative(),
    previewAssetObjectId: designUuidSchema.nullable(),
    previewRevision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine(validatePreviewState);
export type LoomicDesignNodeMetadata = z.infer<
  typeof loomicDesignNodeMetadataSchema
>;

const patchCommonShape = {
  animation: designObjectAnimationSchema.nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  x: finiteNumberSchema.optional(),
  y: finiteNumberSchema.optional(),
  width: positiveFiniteNumberSchema.optional(),
  height: positiveFiniteNumberSchema.optional(),
  rotation: finiteNumberSchema.optional(),
  opacity: finiteNumberSchema.min(0).max(1).optional(),
  z_index: z.number().int().nonnegative().optional(),
  locked: z.boolean().optional(),
  visible: z.boolean().optional(),
} as const;

const textPatchShape = {
  text: z.string().max(100_000).optional(),
  font_face_id: designUuidSchema.nullable().optional(),
  font_family: z.string().trim().min(1).max(200).optional(),
  font_size: positiveFiniteNumberSchema.optional(),
  font_weight: z
    .union([
      z.number().int().min(1).max(1_000),
      z.string().trim().min(1).max(50),
    ])
    .optional(),
  font_style: z.enum(["normal", "italic", "oblique"]).optional(),
  text_align: z.enum(["left", "center", "right", "justify"]).optional(),
  line_height: positiveFiniteNumberSchema.optional(),
  char_spacing: finiteNumberSchema.optional(),
  fill: designPaintSchema.optional(),
  stroke: designPaintSchema.nullable().optional(),
  stroke_width: finiteNumberSchema.nonnegative().optional(),
  shadow: designShadowSchema.nullable().optional(),
} as const;

const shapePatchShape = {
  fill: designPaintSchema.nullable().optional(),
  stroke: designPaintSchema.nullable().optional(),
  stroke_width: finiteNumberSchema.nonnegative().optional(),
  shadow: designShadowSchema.nullable().optional(),
} as const;

const linePatchShape = {
  stroke: designPaintSchema.optional(),
  stroke_width: finiteNumberSchema.nonnegative().optional(),
  x1: finiteNumberSchema.optional(),
  y1: finiteNumberSchema.optional(),
  x2: finiteNumberSchema.optional(),
  y2: finiteNumberSchema.optional(),
} as const;

function requirePatchField<T extends { object_type: string }>(value: T) {
  return Object.keys(value).some((key) => key !== "object_type");
}

const designImagePatchSchema = z
  .object({
    object_type: z.literal("image"),
    ...patchCommonShape,
    asset_object_id: designUuidSchema.optional(),
    resource_id: designUuidSchema.nullable().optional(),
    fit: designImageFitSchema.optional(),
    flip_x: z.boolean().optional(),
    flip_y: z.boolean().optional(),
    crop: designImageCropSchema.nullable().optional(),
    mask: designImageMaskSchema.nullable().optional(),
    filters: designImageFiltersSchema.nullable().optional(),
    stroke: designPaintSchema.nullable().optional(),
    stroke_width: finiteNumberSchema.nonnegative().optional(),
    shadow: designShadowSchema.nullable().optional(),
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designSvgPatchSchema = z
  .object({
    object_type: z.literal("svg"),
    ...patchCommonShape,
    asset_object_id: designUuidSchema.optional(),
    resource_id: designUuidSchema.nullable().optional(),
    flip_x: z.boolean().optional(),
    flip_y: z.boolean().optional(),
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designTextPatchSchema = z
  .object({
    object_type: z.literal("text"),
    ...patchCommonShape,
    ...textPatchShape,
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designTextboxPatchSchema = z
  .object({
    object_type: z.literal("textbox"),
    ...patchCommonShape,
    ...textPatchShape,
    min_width: positiveFiniteNumberSchema.optional(),
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designRectPatchSchema = z
  .object({
    object_type: z.literal("rect"),
    ...patchCommonShape,
    ...shapePatchShape,
    radius_x: finiteNumberSchema.nonnegative().optional(),
    radius_y: finiteNumberSchema.nonnegative().optional(),
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designCirclePatchSchema = z
  .object({
    object_type: z.literal("circle"),
    ...patchCommonShape,
    ...shapePatchShape,
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designTrianglePatchSchema = z
  .object({
    object_type: z.literal("triangle"),
    ...patchCommonShape,
    ...shapePatchShape,
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designLinePatchSchema = z
  .object({
    object_type: z.literal("line"),
    ...patchCommonShape,
    ...linePatchShape,
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designArrowPatchSchema = z
  .object({
    object_type: z.literal("arrow"),
    ...patchCommonShape,
    ...linePatchShape,
    arrow_start: z.enum(["none", "arrow"]).optional(),
    arrow_end: z.enum(["none", "arrow"]).optional(),
  })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

const designGroupPatchSchema = z
  .object({ object_type: z.literal("group"), ...patchCommonShape })
  .strict()
  .refine(requirePatchField, "patch must not be empty");

export const designObjectPatchSchema = z.union([
  designImagePatchSchema,
  designSvgPatchSchema,
  designTextPatchSchema,
  designTextboxPatchSchema,
  designRectPatchSchema,
  designCirclePatchSchema,
  designTrianglePatchSchema,
  designLinePatchSchema,
  designArrowPatchSchema,
  designGroupPatchSchema,
]);
export type DesignObjectPatch = z.infer<typeof designObjectPatchSchema>;

export const designCommandObjectRefSchema = z
  .object({
    object_id: designUuidSchema,
    expected_object_version: z.number().int().positive(),
  })
  .strict();
export type DesignCommandObjectRef = z.infer<
  typeof designCommandObjectRefSchema
>;

const nonEmptyUniqueCommandRefsSchema = z
  .array(designCommandObjectRefSchema)
  .min(1)
  .superRefine((values, context) =>
    addDuplicateIssues(
      values.map((value) => value.object_id),
      context,
      [],
    ),
  );
const alignCommandRefsSchema = z
  .array(designCommandObjectRefSchema)
  .min(2)
  .superRefine((values, context) =>
    addDuplicateIssues(
      values.map((value) => value.object_id),
      context,
      [],
    ),
  );
const distributeCommandRefsSchema = z
  .array(designCommandObjectRefSchema)
  .min(3)
  .superRefine((values, context) =>
    addDuplicateIssues(
      values.map((value) => value.object_id),
      context,
      [],
    ),
  );

export const designObjectAddCommandSchema = z
  .object({ action: z.literal("object.add"), object: newDesignObjectSchema })
  .strict();

export const designObjectUpdateCommandSchema = z
  .object({
    action: z.literal("object.update"),
    object_id: designUuidSchema,
    expected_object_version: z.number().int().positive(),
    patch: designObjectPatchSchema,
  })
  .strict();

export const designObjectRemoveCommandSchema = z
  .object({
    action: z.literal("object.remove"),
    object_id: designUuidSchema,
    expected_object_version: z.number().int().positive(),
  })
  .strict();

export const designObjectCloneCommandSchema = z
  .object({
    action: z.literal("object.clone"),
    source_object_id: designUuidSchema,
    expected_object_version: z.number().int().positive(),
    object: newDesignObjectSchema,
  })
  .strict()
  .refine((value) => value.source_object_id !== value.object.objectId, {
    message: "clone must use a new object id",
    path: ["object", "objectId"],
  });

export const designObjectReorderCommandSchema = z
  .object({
    action: z.literal("object.reorder"),
    object_id: designUuidSchema,
    expected_object_version: z.number().int().positive(),
    to_index: z.number().int().nonnegative(),
  })
  .strict();

export const designObjectsGroupCommandSchema = z
  .object({
    action: z.literal("objects.group"),
    group: newDesignObjectSchema.refine((object) => object.type === "group", {
      message: "group command requires a group object",
    }),
    children: nonEmptyUniqueCommandRefsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.group.type !== "group") return;
    const childIds = value.children.map((child) => child.object_id);
    if (
      childIds.length !== value.group.childObjectIds.length ||
      childIds.some((childId) => !value.group.childObjectIds.includes(childId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "group children must match childObjectIds exactly",
        path: ["children"],
      });
    }
  });

export const designObjectsUngroupCommandSchema = z
  .object({
    action: z.literal("objects.ungroup"),
    group_object_id: designUuidSchema,
    expected_object_version: z.number().int().positive(),
  })
  .strict();

export const designObjectAlignmentSchema = z.enum([
  "left",
  "horizontal_center",
  "right",
  "top",
  "vertical_center",
  "bottom",
]);

export const designObjectsAlignCommandSchema = z
  .object({
    action: z.literal("objects.align"),
    alignment: designObjectAlignmentSchema,
    objects: alignCommandRefsSchema,
  })
  .strict();

export const designObjectsDistributeCommandSchema = z
  .object({
    action: z.literal("objects.distribute"),
    direction: z.enum(["horizontal", "vertical"]),
    objects: distributeCommandRefsSchema,
  })
  .strict();

export const designObjectSetRoleCommandSchema = z
  .object({
    action: z.literal("object.set_role"),
    object_id: designUuidSchema,
    expected_object_version: z.number().int().positive(),
    role: designObjectRoleSchema.nullable(),
  })
  .strict();

export const designCanvasUpdateCommandSchema = z
  .object({
    action: z.literal("canvas.update"),
    width: designDimensionSchema.optional(),
    height: designDimensionSchema.optional(),
    background: colorSchema.nullable().optional(),
    resize_mode: z.enum(["crop", "expand", "scale"]).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "action"),
    "canvas update must not be empty",
  );

export type DesignCanvasUpdateCommand = z.infer<
  typeof designCanvasUpdateCommandSchema
>;

/**
 * Canonical canvas.update reducer shared by browser and server. Scale mode
 * preserves aspect ratios, fits the old canvas inside the new canvas, and
 * centers the scaled content in the remaining axis.
 */
export function applyDesignCanvasUpdate(
  inputScene: LoomicSceneV1,
  inputCommand: DesignCanvasUpdateCommand,
): LoomicSceneV1 {
  // Zod returns a deep clone, which keeps this helper runtime-agnostic (the
  // shared package intentionally does not require the DOM structuredClone API).
  const scene = loomicSceneV1Schema.parse(inputScene);
  const command = designCanvasUpdateCommandSchema.parse(inputCommand);
  const previousWidth = scene.canvas.width;
  const previousHeight = scene.canvas.height;
  const nextWidth = command.width ?? previousWidth;
  const nextHeight = command.height ?? previousHeight;
  const dimensionsChanged =
    nextWidth !== previousWidth || nextHeight !== previousHeight;

  if (command.resize_mode === "scale" && dimensionsChanged) {
    const scale = Math.min(
      nextWidth / previousWidth,
      nextHeight / previousHeight,
    );
    const offsetX = (nextWidth - previousWidth * scale) / 2;
    const offsetY = (nextHeight - previousHeight * scale) / 2;
    scene.objects = scene.objects.map((object) => {
      object.x = object.x * scale + offsetX;
      object.y = object.y * scale + offsetY;
      object.width *= scale;
      object.height *= scale;
      object.objectVersion += 1;

      if (object.type === "line" || object.type === "arrow") {
        object.x1 = object.x1 * scale + offsetX;
        object.y1 = object.y1 * scale + offsetY;
        object.x2 = object.x2 * scale + offsetX;
        object.y2 = object.y2 * scale + offsetY;
        object.strokeWidth *= scale;
      }
      if (object.type === "text" || object.type === "textbox") {
        object.fontSize *= scale;
        if (object.strokeWidth !== undefined) object.strokeWidth *= scale;
        if (object.type === "textbox" && object.minWidth !== undefined) {
          object.minWidth *= scale;
        }
      }
      if (
        object.type === "rect" ||
        object.type === "circle" ||
        object.type === "triangle"
      ) {
        object.strokeWidth *= scale;
        if (object.type === "rect") {
          if (object.radiusX !== undefined) object.radiusX *= scale;
          if (object.radiusY !== undefined) object.radiusY *= scale;
        }
      }
      if ("shadow" in object && object.shadow) {
        object.shadow.blur *= scale;
        object.shadow.offsetX *= scale;
        object.shadow.offsetY *= scale;
      }
      return object;
    });
  }

  scene.canvas.width = nextWidth;
  scene.canvas.height = nextHeight;
  if (command.background !== undefined) {
    scene.canvas.background = command.background;
  }
  return loomicSceneV1Schema.parse(scene);
}

export const designSceneReplaceCommandSchema = z
  .object({ action: z.literal("scene.replace"), scene: loomicSceneV1Schema })
  .strict();

// Zod v3 cannot form a discriminated union from refined command members. Each
// member nevertheless has a closed, literal `action` discriminator.
export const designCommandSchema = z.union([
  designObjectAddCommandSchema,
  designObjectUpdateCommandSchema,
  designObjectRemoveCommandSchema,
  designObjectCloneCommandSchema,
  designObjectReorderCommandSchema,
  designObjectsGroupCommandSchema,
  designObjectsUngroupCommandSchema,
  designObjectsAlignCommandSchema,
  designObjectsDistributeCommandSchema,
  designObjectSetRoleCommandSchema,
  designCanvasUpdateCommandSchema,
  designSceneReplaceCommandSchema,
]);
export type DesignCommand = z.infer<typeof designCommandSchema>;

export const designMutationRequestSchema = z
  .object({
    design_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    commands: z.array(designCommandSchema).min(1).max(500),
  })
  .strict();
export type DesignMutationRequest = z.infer<typeof designMutationRequestSchema>;

export const designMutationResponseSchema = z
  .object({
    design_id: designUuidSchema,
    revision: z.number().int().positive(),
    changed_object_ids: uniqueUuidArraySchema,
    replayed: z.boolean(),
  })
  .strict();
export type DesignMutationResponse = z.infer<
  typeof designMutationResponseSchema
>;

const canvasElementIdSchema = z.string().trim().min(1).max(200);
const canvasElementVersionSchema = z.number().int().nonnegative();

export const manualCanvasImageScenePoseSchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: positiveFiniteNumberSchema,
    height: positiveFiniteNumberSchema,
    // Excalidraw stores scene angles in radians.
    angle: finiteNumberSchema,
  })
  .strict();
export type ManualCanvasImageScenePose = z.infer<
  typeof manualCanvasImageScenePoseSchema
>;

export const manualCanvasImagePlacementSchema = z.union([
  z.object({ kind: z.literal("fit") }).strict(),
  z
    .object({
      kind: z.literal("preserve"),
      scene_pose: manualCanvasImageScenePoseSchema.optional(),
    })
    .strict(),
]);
export type ManualCanvasImagePlacement = z.infer<
  typeof manualCanvasImagePlacementSchema
>;

/**
 * Imports an already-persisted canvas image as one native design object.
 * asset_object_id is intentionally absent: the server resolves it from the
 * authorized, version-guarded canvas element instead of trusting the caller.
 */
export const manualCanvasImageImportRequestSchema = z
  .object({
    request_id: designUuidSchema,
    design_id: designUuidSchema,
    expected_design_revision: z.number().int().nonnegative(),
    canvas_id: designUuidSchema,
    source_element_id: canvasElementIdSchema,
    expected_source_element_version: canvasElementVersionSchema,
    board_element_id: canvasElementIdSchema,
    expected_board_element_version: canvasElementVersionSchema,
    mode: z.enum(["copy", "adopt"]),
    placement: manualCanvasImagePlacementSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.placement.kind === "preserve" &&
      value.placement.scene_pose !== undefined &&
      value.mode !== "copy"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scene_pose is only valid for a copy import",
        path: ["placement", "scene_pose"],
      });
    }
    if (value.source_element_id === value.board_element_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source and board elements must be different",
        path: ["board_element_id"],
      });
    }
  });
export type ManualCanvasImageImportRequest = z.infer<
  typeof manualCanvasImageImportRequestSchema
>;

export const manualCanvasImageImportResponseSchema = z
  .object({
    operation_id: designUuidSchema,
    design_id: designUuidSchema,
    design_revision: z.number().int().positive(),
    object_id: designUuidSchema,
    object_version: z.literal(1),
    source_canvas_id: designUuidSchema,
    source_canvas_revision: z.number().int().nonnegative(),
    source_element_id: canvasElementIdSchema,
    source_element_version: canvasElementVersionSchema,
    mode: z.enum(["copy", "adopt"]),
    replayed: z.boolean(),
  })
  .strict();
export type ManualCanvasImageImportResponse = z.infer<
  typeof manualCanvasImageImportResponseSchema
>;

export const undoManualCanvasImageImportRequestSchema = z
  .object({
    idempotency_key: designUuidSchema,
    expected_design_revision: z.number().int().nonnegative(),
    expected_object_version: z.number().int().positive(),
  })
  .strict();
export type UndoManualCanvasImageImportRequest = z.infer<
  typeof undoManualCanvasImageImportRequestSchema
>;

export const undoManualCanvasImageImportResponseSchema = z
  .object({
    operation_id: designUuidSchema,
    design_id: designUuidSchema,
    design_revision: z.number().int().positive(),
    object_id: designUuidSchema,
    removed: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();
export type UndoManualCanvasImageImportResponse = z.infer<
  typeof undoManualCanvasImageImportResponseSchema
>;

export const designConflictResponseSchema = z
  .object({
    error: z
      .object({
        code: z.literal("DESIGN_CONFLICT"),
        message: z.string().min(1),
        design_id: designUuidSchema,
        latest_revision: z.number().int().nonnegative(),
        conflict_object_ids: uniqueUuidArraySchema,
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type DesignConflictResponse = z.infer<
  typeof designConflictResponseSchema
>;

export const canvasRevisionConflictResponseSchema = z
  .object({
    error: z
      .object({
        code: z.literal("CANVAS_REVISION_CONFLICT"),
        message: z.string().min(1),
        canvas_id: designUuidSchema,
        latest_revision: z.number().int().nonnegative(),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type CanvasRevisionConflictResponse = z.infer<
  typeof canvasRevisionConflictResponseSchema
>;

export const createDesignRequestSchema = z
  .object({
    request_id: designUuidSchema,
    canvas_id: designUuidSchema,
    expected_canvas_revision: z.number().int().nonnegative(),
    canvas_element_id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional(),
    width: designDimensionSchema,
    height: designDimensionSchema,
    background: colorSchema.nullable(),
    template_id: designUuidSchema.optional(),
    node: z
      .object({
        x: finiteNumberSchema,
        y: finiteNumberSchema,
        width: positiveFiniteNumberSchema,
        height: positiveFiniteNumberSchema,
      })
      .strict(),
  })
  .strict();
export type CreateDesignRequest = z.infer<typeof createDesignRequestSchema>;

export const createDesignResponseSchema = z
  .object({
    design_id: designUuidSchema,
    canvas_element_id: z.string().min(1),
    design_revision: z.number().int().nonnegative(),
    canvas_revision: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();
export type CreateDesignResponse = z.infer<typeof createDesignResponseSchema>;

const designRevisionMutationShape = {
  design_id: designUuidSchema,
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: designUuidSchema,
} as const;

export const renameDesignRequestSchema = z
  .object({
    ...designRevisionMutationShape,
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type RenameDesignRequest = z.infer<typeof renameDesignRequestSchema>;

export const deleteDesignRequestSchema = z
  .object({ ...designRevisionMutationShape })
  .strict();
export type DeleteDesignRequest = z.infer<typeof deleteDesignRequestSchema>;

export const restoreDesignRequestSchema = z
  .object({ ...designRevisionMutationShape })
  .strict();
export type RestoreDesignRequest = z.infer<typeof restoreDesignRequestSchema>;

export const designLifecycleResponseSchema = z
  .object({
    design_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();
export type DesignLifecycleResponse = z.infer<
  typeof designLifecycleResponseSchema
>;

export const copyDesignRequestSchema = z
  .object({
    request_id: designUuidSchema,
    source_design_id: designUuidSchema,
    canvas_id: designUuidSchema,
    expected_canvas_revision: z.number().int().nonnegative(),
    canvas_element_id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional(),
    node: z
      .object({
        x: finiteNumberSchema,
        y: finiteNumberSchema,
        width: positiveFiniteNumberSchema,
        height: positiveFiniteNumberSchema,
      })
      .strict(),
  })
  .strict();
export type CopyDesignRequest = z.infer<typeof copyDesignRequestSchema>;

export const queueDesignPreviewRequestSchema = z
  .object({ ...designRevisionMutationShape })
  .strict();
export type QueueDesignPreviewRequest = z.infer<
  typeof queueDesignPreviewRequestSchema
>;

const queueDesignPreviewResponseBaseShape = {
  design_id: designUuidSchema,
  revision: z.number().int().nonnegative(),
  replayed: z.boolean(),
} as const;

export const queueDesignPreviewResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...queueDesignPreviewResponseBaseShape,
      status: z.literal("queued"),
      job_id: designUuidSchema,
    })
    .strict(),
  z
    .object({
      ...queueDesignPreviewResponseBaseShape,
      status: z.literal("ready"),
      job_id: z.null(),
    })
    .strict(),
]);
export type QueueDesignPreviewResponse = z.infer<
  typeof queueDesignPreviewResponseSchema
>;

export const commitDesignPreviewRequestSchema = z
  .object({
    design_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    preview_asset_object_id: designUuidSchema,
    preview_revision: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.preview_revision === value.expected_revision, {
    message: "preview must be generated from the expected revision",
    path: ["preview_revision"],
  });
export type CommitDesignPreviewRequest = z.infer<
  typeof commitDesignPreviewRequestSchema
>;

function validateSnakePreviewState(
  value: {
    revision: number;
    preview_asset_object_id: string | null;
    preview_revision: number;
  },
  context: z.RefinementCtx,
) {
  if (value.preview_revision > value.revision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "preview revision cannot exceed document revision",
      path: ["preview_revision"],
    });
  }
  if (value.preview_asset_object_id === null && value.preview_revision !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a missing preview asset requires preview revision 0",
      path: ["preview_revision"],
    });
  }
}

function validateDocumentPreviewState(
  value: {
    revision: number;
    preview_asset_object_id: string | null;
    preview_revision: number;
    preview_status: "missing" | "queued" | "ready" | "stale" | "error";
  },
  context: z.RefinementCtx,
) {
  validateSnakePreviewState(value, context);
  const hasPreview = value.preview_asset_object_id !== null;
  const isEmpty = !hasPreview && value.preview_revision === 0;
  const isCurrent = hasPreview && value.preview_revision === value.revision;
  const isOlder = hasPreview && value.preview_revision < value.revision;

  if (value.preview_status === "missing" && !isEmpty) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "missing preview status requires no asset and revision 0",
      path: ["preview_status"],
    });
  }
  if (value.preview_status === "ready" && !isCurrent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ready preview status requires an asset at the current revision",
      path: ["preview_status"],
    });
  }
  if (value.preview_status === "stale" && !isOlder) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "stale preview status requires an asset from an older revision",
      path: ["preview_status"],
    });
  }
  if (
    (value.preview_status === "queued" || value.preview_status === "error") &&
    !isEmpty &&
    !isOlder
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "queued or error preview status requires no preview or an older preview",
      path: ["preview_status"],
    });
  }
}

export const designDocumentDtoSchema = z
  .object({
    id: designUuidSchema,
    workspace_id: designUuidSchema,
    project_id: designUuidSchema,
    name: z.string().min(1),
    width: designDimensionSchema,
    height: designDimensionSchema,
    revision: z.number().int().nonnegative(),
    scene: loomicSceneV1Schema,
    preview_asset_object_id: designUuidSchema.nullable(),
    preview_revision: z.number().int().nonnegative(),
    preview_status: z.enum(["missing", "queued", "ready", "stale", "error"]),
    deleted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.width !== value.scene.canvas.width ||
      value.height !== value.scene.canvas.height
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "document dimensions must match scene canvas dimensions",
        path: ["scene", "canvas"],
      });
    }
    validateDocumentPreviewState(value, context);
  });
export type DesignDocumentDto = z.infer<typeof designDocumentDtoSchema>;

export const designDocumentVersionDtoSchema = z
  .object({
    id: designUuidSchema,
    design_id: designUuidSchema,
    workspace_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    parent_revision: z.number().int().nonnegative().nullable(),
    command_batch: z.array(designCommandSchema),
    changed_object_ids: uniqueUuidArraySchema,
    snapshot: loomicSceneV1Schema.nullable(),
    actor_kind: z.enum(["user", "agent", "system", "job"]),
    actor_user_id: designUuidSchema.nullable(),
    agent_run_id: designUuidSchema.nullable(),
    tool_execution_id: designUuidSchema.nullable(),
    idempotency_key: designUuidSchema,
    created_at: timestampSchema,
  })
  .strict();
export type DesignDocumentVersionDto = z.infer<
  typeof designDocumentVersionDtoSchema
>;

export const designDocumentAssetRefDtoSchema = z
  .object({
    design_id: designUuidSchema,
    workspace_id: designUuidSchema,
    object_id: designUuidSchema,
    slot: z.string().trim().min(1).max(80),
    asset_object_id: designUuidSchema,
    resource_id: designUuidSchema.nullable(),
  })
  .strict();
export type DesignDocumentAssetRefDto = z.infer<
  typeof designDocumentAssetRefDtoSchema
>;

export const designDocumentFontRefDtoSchema = z
  .object({
    design_id: designUuidSchema,
    workspace_id: designUuidSchema,
    object_id: designUuidSchema,
    font_face_id: designUuidSchema,
  })
  .strict();
export type DesignDocumentFontRefDto = z.infer<
  typeof designDocumentFontRefDtoSchema
>;

export const designGetResponseSchema = z
  .object({ design: designDocumentDtoSchema })
  .strict();
export type DesignGetResponse = z.infer<typeof designGetResponseSchema>;

export const designReferencesResponseSchema = z
  .object({
    assets: z.array(designDocumentAssetRefDtoSchema),
    fonts: z.array(designDocumentFontRefDtoSchema),
  })
  .strict();
export type DesignReferencesResponse = z.infer<
  typeof designReferencesResponseSchema
>;

export const designErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "design_not_found",
          "design_forbidden",
          "design_invalid",
          "design_create_failed",
          "design_query_failed",
          "design_write_failed",
        ]),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type DesignErrorResponse = z.infer<typeof designErrorResponseSchema>;

export const designSyncEventSchema = z
  .object({
    type: z.literal("design.sync"),
    designId: designUuidSchema,
    revision: z.number().int().nonnegative(),
    updateType: z.enum([
      "created",
      "mutated",
      "renamed",
      "preview",
      "deleted",
      "restored",
    ]),
    changedObjectIds: uniqueUuidArraySchema.optional(),
    previewAssetObjectId: designUuidSchema.nullable().optional(),
    previewRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasAsset = value.previewAssetObjectId !== undefined;
    const hasRevision = value.previewRevision !== undefined;
    if (hasAsset !== hasRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "preview asset and revision must be supplied together",
        path: hasAsset ? ["previewRevision"] : ["previewAssetObjectId"],
      });
      return;
    }
    if (hasAsset && hasRevision) {
      validatePreviewState(
        {
          revision: value.revision,
          previewAssetObjectId: value.previewAssetObjectId ?? null,
          previewRevision: value.previewRevision ?? 0,
        },
        context,
      );
    }
  });
export type DesignSyncEvent = z.infer<typeof designSyncEventSchema>;

export const canvasJobPlacementSchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: positiveFiniteNumberSchema.optional(),
    height: positiveFiniteNumberSchema.optional(),
  })
  .strict();
export type CanvasJobPlacement = z.infer<typeof canvasJobPlacementSchema>;

export const designJobPlacementSchema = z
  .object({
    layer_index: z.number().int().nonnegative().optional(),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: positiveFiniteNumberSchema.optional(),
    height: positiveFiniteNumberSchema.optional(),
    fit: designImageFitSchema.optional(),
    role: designObjectRoleSchema.optional(),
    replace_object_id: designUuidSchema.optional(),
  })
  .strict();
export type DesignJobPlacement = z.infer<typeof designJobPlacementSchema>;

// Backward-compatible export name for clients that adopted the initial draft.
export const designPlacementSchema = designJobPlacementSchema;
export type DesignPlacement = DesignJobPlacement;

export const canvasJobTargetSchema = z
  .object({
    kind: z.literal("canvas"),
    canvas_id: designUuidSchema,
    element_id: z.string().trim().min(1).max(200).optional(),
    placement: canvasJobPlacementSchema.optional(),
  })
  .strict();

export const designJobTargetSchema = z
  .object({
    kind: z.literal("design"),
    design_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    source_object_id: designUuidSchema.optional(),
    expected_object_version: z.number().int().positive().optional(),
    source_asset_object_id: designUuidSchema.optional(),
    placement: designJobPlacementSchema.optional(),
  })
  .strict();

export const jobTargetSchema = z
  .union([canvasJobTargetSchema, designJobTargetSchema])
  .superRefine((value, context) => {
    if (value.kind !== "design") return;
    const sourceFields = [
      value.source_object_id,
      value.expected_object_version,
      value.source_asset_object_id,
    ];
    const supplied = sourceFields.filter((field) => field !== undefined).length;
    if (supplied !== 0 && supplied !== sourceFields.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "design source binding must be complete",
        path: ["source_object_id"],
      });
    }
    if (
      value.source_object_id &&
      value.placement?.replace_object_id &&
      value.source_object_id !== value.placement.replace_object_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement must target the bound source object",
        path: ["placement", "replace_object_id"],
      });
    }
  });
export type CanvasJobTarget = z.infer<typeof canvasJobTargetSchema>;
export type DesignJobTarget = z.infer<typeof designJobTargetSchema>;
export type JobTarget = z.infer<typeof jobTargetSchema>;

export const designExportFormatSchema = z.enum(["png", "jpeg"]);

export const designExportRequestSchema = z
  .object({
    design_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    format: designExportFormatSchema,
    multiplier: z.union([z.literal(1), z.literal(2)]),
    transparent: z.boolean(),
  })
  .strict()
  .refine((value) => value.format === "png" || !value.transparent, {
    message: "JPEG export cannot be transparent",
    path: ["transparent"],
  });
export type DesignExportRequest = z.infer<typeof designExportRequestSchema>;

export const designExportPayloadSchema = z
  .object({
    design_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    requested_by: designUuidSchema,
    format: designExportFormatSchema,
    multiplier: z.union([z.literal(1), z.literal(2)]),
    transparent: z.boolean(),
  })
  .strict()
  .refine((value) => value.format === "png" || !value.transparent, {
    message: "JPEG export cannot be transparent",
    path: ["transparent"],
  });
export type DesignExportPayload = z.infer<typeof designExportPayloadSchema>;

export const designExportResultSchema = z
  .object({
    asset_object_id: designUuidSchema,
    design_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    format: designExportFormatSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    byte_size: z.number().int().nonnegative(),
    expires_at: timestampSchema,
  })
  .strict();
export type DesignExportResult = z.infer<typeof designExportResultSchema>;

export const designResourceScopeSchema = z.enum(["platform", "workspace"]);
export const designCatalogStatusSchema = z.enum([
  "draft",
  "pending_review",
  "published",
  "rejected",
  "disabled",
]);
// Compatibility alias; the canonical name reflects that this also covers
// drafts and disabled catalog rows, not only publication.
export const designPublicationStatusSchema = designCatalogStatusSchema;

export const designResourceKindSchema = z.enum([
  "image",
  "svg",
  "illustration",
  "icon",
  "background",
  "mockup",
]);
export const designResourceTypeSchema = designResourceKindSchema;
export type DesignResourceScope = z.infer<typeof designResourceScopeSchema>;
export type DesignCatalogStatus = z.infer<typeof designCatalogStatusSchema>;
export type DesignPublicationStatus = DesignCatalogStatus;
export type DesignResourceKind = z.infer<typeof designResourceKindSchema>;
export type DesignResourceType = DesignResourceKind;

function validateScopeWorkspace(
  value: { scope: "platform" | "workspace"; workspace_id: string | null },
  context: z.RefinementCtx,
) {
  const valid =
    (value.scope === "platform" && value.workspace_id === null) ||
    (value.scope === "workspace" && value.workspace_id !== null);
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "platform rows require null workspace_id; workspace rows require one",
      path: ["workspace_id"],
    });
  }
}

const catalogAttributionShape = {
  source_url: z.string().url().nullable(),
  author: z.string().max(300).nullable(),
  license_name: z.string().max(300).nullable(),
  license_url: z.string().url().nullable(),
  attribution: z.string().max(2_000).nullable(),
  usage_restrictions: z.string().max(2_000).nullable(),
} as const;

export const designResourceDtoSchema = z
  .object({
    id: designUuidSchema,
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    kind: designResourceKindSchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).nullable(),
    asset_object_id: designUuidSchema,
    preview_asset_object_id: designUuidSchema.nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    checksum_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    revision: z.number().int().nonnegative(),
    status: designCatalogStatusSchema,
    category_id: designUuidSchema.nullable(),
    tag_ids: uniqueUuidArraySchema,
    ...catalogAttributionShape,
    deleted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateScopeWorkspace(value, context);
    if ((value.width === null) !== (value.height === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resource width and height must be supplied together",
        path: [value.width === null ? "width" : "height"],
      });
    }
  });
export type DesignResourceDto = z.infer<typeof designResourceDtoSchema>;

export const designFontFamilyDtoSchema = z
  .object({
    id: designUuidSchema,
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    name: z.string().trim().min(1).max(200),
    revision: z.number().int().nonnegative(),
    status: designCatalogStatusSchema,
    ...catalogAttributionShape,
    deleted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type DesignFontFamilyDto = z.infer<typeof designFontFamilyDtoSchema>;

export const designFontFaceDtoSchema = z
  .object({
    id: designUuidSchema,
    family_id: designUuidSchema,
    family_name: z.string().trim().min(1).max(200),
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    style: z.enum(["normal", "italic", "oblique"]),
    weight: z.number().int().min(1).max(1_000),
    format: z.enum(["woff2", "woff", "ttf", "otf"]),
    asset_object_id: designUuidSchema,
    status: designCatalogStatusSchema,
    checksum_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    allow_web_embed: z.boolean(),
    revision: z.number().int().nonnegative(),
    deleted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type DesignFontFaceDto = z.infer<typeof designFontFaceDtoSchema>;

const designTemplateVariableBaseShape = {
  key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_.-]*$/),
  label: z.string().trim().min(1).max(120),
  required: z.boolean(),
} as const;

export const designTemplateTextVariableSchema = z
  .object({
    ...designTemplateVariableBaseShape,
    type: z.literal("text"),
    target: z
      .object({ object_id: designUuidSchema, property: z.literal("text") })
      .strict(),
    default_value: z.string().max(100_000).optional(),
  })
  .strict();
export const designTemplateImageValueSchema = z
  .object({
    asset_object_id: designUuidSchema,
    resource_id: designUuidSchema.nullable().optional(),
  })
  .strict();
export const designTemplateImageVariableSchema = z
  .object({
    ...designTemplateVariableBaseShape,
    type: z.literal("image"),
    target: z
      .object({
        object_id: designUuidSchema,
        property: z.literal("asset_object_id"),
      })
      .strict(),
    default_value: designTemplateImageValueSchema.optional(),
  })
  .strict();
export const designTemplateColorVariableSchema = z
  .object({
    ...designTemplateVariableBaseShape,
    type: z.literal("color"),
    target: z
      .object({
        object_id: designUuidSchema,
        property: z.enum(["fill", "stroke"]),
      })
      .strict(),
    default_value: colorSchema.optional(),
  })
  .strict();
export const designTemplateFontValueSchema = z
  .object({
    font_face_id: designUuidSchema,
    font_family: z.string().trim().min(1).max(200),
  })
  .strict();
export const designTemplateFontVariableSchema = z
  .object({
    ...designTemplateVariableBaseShape,
    type: z.literal("font"),
    target: z
      .object({
        object_id: designUuidSchema,
        property: z.literal("font_face_id"),
      })
      .strict(),
    default_value: designTemplateFontValueSchema.optional(),
  })
  .strict();
export const designTemplateVariableSchema = z.discriminatedUnion("type", [
  designTemplateTextVariableSchema,
  designTemplateImageVariableSchema,
  designTemplateColorVariableSchema,
  designTemplateFontVariableSchema,
]);
export const designTemplateVariablesSchema = z
  .array(designTemplateVariableSchema)
  .max(100)
  .superRefine((variables, context) => {
    addDuplicateIssues(
      variables.map((variable) => variable.key),
      context,
      [],
    );
  });
export type DesignTemplateVariable = z.infer<
  typeof designTemplateVariableSchema
>;

export const designTemplateDtoSchema = z
  .object({
    id: designUuidSchema,
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).nullable(),
    width: designDimensionSchema,
    height: designDimensionSchema,
    schema_version: z.literal(1),
    engine_version: z.literal("fabric@7.4.0"),
    revision: z.number().int().nonnegative(),
    status: designCatalogStatusSchema,
    preview_asset_object_id: designUuidSchema.nullable(),
    category_id: designUuidSchema.nullable(),
    tag_ids: uniqueUuidArraySchema,
    variables: designTemplateVariablesSchema.default([]),
    ...catalogAttributionShape,
    deleted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type DesignTemplateDto = z.infer<typeof designTemplateDtoSchema>;

export const designTemplateAssetRefDtoSchema = z
  .object({
    template_id: designUuidSchema,
    object_id: designUuidSchema,
    slot: z.string().trim().min(1).max(80),
    asset_object_id: designUuidSchema,
    resource_id: designUuidSchema.nullable(),
  })
  .strict();
export type DesignTemplateAssetRefDto = z.infer<
  typeof designTemplateAssetRefDtoSchema
>;

export const designTemplateDetailDtoSchema = z
  .object({
    template: designTemplateDtoSchema,
    scene: loomicSceneV1Schema,
    asset_refs: z.array(designTemplateAssetRefDtoSchema),
    font_face_ids: uniqueUuidArraySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.template.width !== value.scene.canvas.width ||
      value.template.height !== value.scene.canvas.height
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "template dimensions must match scene canvas dimensions",
        path: ["scene", "canvas"],
      });
    }
  });
export type DesignTemplateDetailDto = z.infer<
  typeof designTemplateDetailDtoSchema
>;

const templateBindingBaseShape = { key: z.string().trim().min(1).max(80) };
export const designTemplateBindingSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...templateBindingBaseShape,
      type: z.literal("text"),
      value: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      ...templateBindingBaseShape,
      type: z.literal("image"),
      value: designTemplateImageValueSchema,
    })
    .strict(),
  z
    .object({
      ...templateBindingBaseShape,
      type: z.literal("color"),
      value: colorSchema,
    })
    .strict(),
  z
    .object({
      ...templateBindingBaseShape,
      type: z.literal("font"),
      value: designTemplateFontValueSchema,
    })
    .strict(),
]);

const smartSelectorSchema = z
  .object({
    role: designObjectRoleSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.name !== undefined, {
    message: "smart selector requires a role or name",
  });
export const designTemplateSmartBindingSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      selector: smartSelectorSchema,
      value: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      selector: smartSelectorSchema,
      value: designTemplateImageValueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("color"),
      selector: smartSelectorSchema,
      value: colorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("font"),
      selector: smartSelectorSchema,
      value: designTemplateFontValueSchema,
    })
    .strict(),
]);

const designTemplateReplaceBaseShape = {
  design_id: designUuidSchema,
  template_id: designUuidSchema,
  expected_revision: z.number().int().nonnegative(),
  expected_template_revision: z.number().int().nonnegative(),
  bindings: z.array(designTemplateBindingSchema).max(100).default([]),
  smart_bindings: z
    .array(designTemplateSmartBindingSchema)
    .max(100)
    .default([]),
} as const;
export const designTemplateReplacePreviewRequestSchema = z
  .object(designTemplateReplaceBaseShape)
  .strict()
  .superRefine((value, context) =>
    addDuplicateIssues(
      value.bindings.map((binding) => binding.key),
      context,
      ["bindings"],
    ),
  );
export type DesignTemplateReplacePreviewRequest = z.infer<
  typeof designTemplateReplacePreviewRequestSchema
>;
export const designTemplateReplaceApplyRequestSchema = z
  .object({
    ...designTemplateReplaceBaseShape,
    idempotency_key: designUuidSchema,
  })
  .strict()
  .superRefine((value, context) =>
    addDuplicateIssues(
      value.bindings.map((binding) => binding.key),
      context,
      ["bindings"],
    ),
  );
export type DesignTemplateReplaceApplyRequest = z.infer<
  typeof designTemplateReplaceApplyRequestSchema
>;
export const designTemplateReplaceDiffSchema = z
  .object({
    variable_key: z.string().min(1).max(80),
    type: z.enum(["text", "image", "color", "font"]),
    object_id: designUuidSchema,
    property: z.enum([
      "text",
      "asset_object_id",
      "fill",
      "stroke",
      "font_face_id",
    ]),
    source: z.enum(["binding", "smart", "default"]),
    before: z.unknown(),
    after: z.unknown(),
  })
  .strict();
export const designTemplateReplacePreviewResponseSchema = z
  .object({
    design_id: designUuidSchema,
    template_id: designUuidSchema,
    design_revision: z.number().int().nonnegative(),
    template_revision: z.number().int().nonnegative(),
    commands: z.array(designCommandSchema).max(100),
    differences: z.array(designTemplateReplaceDiffSchema).max(100),
    unresolved_keys: z.array(z.string().min(1).max(80)).max(100),
  })
  .strict();
export type DesignTemplateReplacePreviewResponse = z.infer<
  typeof designTemplateReplacePreviewResponseSchema
>;
export const designTemplateReplaceApplyResponseSchema = z
  .object({
    preview: designTemplateReplacePreviewResponseSchema,
    mutation: designMutationResponseSchema,
  })
  .strict();
export type DesignTemplateReplaceApplyResponse = z.infer<
  typeof designTemplateReplaceApplyResponseSchema
>;
export const updateDesignTemplateVariablesRequestSchema = z
  .object({
    request_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    variables: designTemplateVariablesSchema,
  })
  .strict();
export type UpdateDesignTemplateVariablesRequest = z.infer<
  typeof updateDesignTemplateVariablesRequestSchema
>;

export const designTextPresetObjectSchema = z.union([
  designTextObjectSchema,
  designTextboxObjectSchema,
  designRectObjectSchema,
  designCircleObjectSchema,
  designTriangleObjectSchema,
  designGroupObjectSchema,
]);

export const designTextPresetContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    objects: z.array(designTextPresetObjectSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const fragmentResult = loomicSceneV1Schema.safeParse({
      schemaVersion: 1,
      engine: "fabric",
      canvas: { width: 1, height: 1, background: null },
      objects: value.objects,
    });
    if (!fragmentResult.success) {
      for (const issue of fragmentResult.error.issues) {
        if (issue.path[0] !== "objects") continue;
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        });
      }
    }
  });
export type DesignTextPresetContent = z.infer<
  typeof designTextPresetContentSchema
>;

// Kept as an additive compatibility export; persisted `style` now contains a
// constrained editable object fragment rather than an unstructured style map.
export const designTextPresetStyleSchema = designTextPresetContentSchema;

export const designTextPresetDtoSchema = z
  .object({
    id: designUuidSchema,
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    name: z.string().trim().min(1).max(200),
    style: designTextPresetContentSchema,
    preview_asset_object_id: designUuidSchema.nullable(),
    revision: z.number().int().nonnegative(),
    status: designCatalogStatusSchema,
    category_id: designUuidSchema.nullable(),
    tag_ids: uniqueUuidArraySchema,
    ...catalogAttributionShape,
    deleted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type DesignTextPresetDto = z.infer<typeof designTextPresetDtoSchema>;

export const designTextPresetDetailDtoSchema = z
  .object({
    preset: designTextPresetDtoSchema,
    font_face_ids: uniqueUuidArraySchema,
  })
  .strict();
export type DesignTextPresetDetailDto = z.infer<
  typeof designTextPresetDetailDtoSchema
>;

export const designResourceCategoryDtoSchema = z
  .object({
    id: designUuidSchema,
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    parent_id: designUuidSchema.nullable(),
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().min(1).max(120),
    sort_order: z.number().int(),
    revision: z.number().int().nonnegative(),
    status: designCatalogStatusSchema,
    deleted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateScopeWorkspace(value, context);
    if (value.parent_id === value.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "category cannot be its own parent",
        path: ["parent_id"],
      });
    }
  });
export type DesignResourceCategoryDto = z.infer<
  typeof designResourceCategoryDtoSchema
>;

export const designResourceTagDtoSchema = z
  .object({
    id: designUuidSchema,
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    name: z.string().trim().min(1).max(80),
    slug: z.string().trim().min(1).max(80),
    revision: z.number().int().nonnegative(),
    status: designCatalogStatusSchema,
    deleted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type DesignResourceTagDto = z.infer<typeof designResourceTagDtoSchema>;

export const designResourceFavoriteDtoSchema = z
  .object({
    user_id: designUuidSchema,
    resource_id: designUuidSchema,
    created_at: timestampSchema,
  })
  .strict();
export type DesignResourceFavoriteDto = z.infer<
  typeof designResourceFavoriteDtoSchema
>;

export const designResourceRecentUseDtoSchema = z
  .object({
    user_id: designUuidSchema,
    resource_id: designUuidSchema,
    workspace_id: designUuidSchema,
    used_at: timestampSchema,
    use_count: z.number().int().positive(),
  })
  .strict();
export type DesignResourceRecentUseDto = z.infer<
  typeof designResourceRecentUseDtoSchema
>;

export const designResourceListRequestSchema = z
  .object({
    scope: designResourceScopeSchema.optional(),
    kind: designResourceKindSchema.optional(),
    status: designCatalogStatusSchema.optional(),
    query: z.string().trim().max(200).optional(),
    category_id: designUuidSchema.optional(),
    tag_id: designUuidSchema.optional(),
    collection: z.enum(["favorites", "recent"]).optional(),
    collection_workspace_id: designUuidSchema.optional(),
    format: z.enum(["png", "jpeg", "webp", "gif", "svg"]).optional(),
    aspect_ratio: z
      .enum(["square", "portrait", "landscape", "wide"])
      .optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.collection === "recent" && !value.collection_workspace_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recent collection requires collection_workspace_id",
        path: ["collection_workspace_id"],
      });
    }
    if (value.collection !== "recent" && value.collection_workspace_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "collection_workspace_id is only valid for recent collection",
        path: ["collection_workspace_id"],
      });
    }
  });

export const designResourceListResponseSchema = z
  .object({
    items: z.array(designResourceDtoSchema),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type DesignResourceListRequest = z.infer<
  typeof designResourceListRequestSchema
>;
export type DesignResourceListResponse = z.infer<
  typeof designResourceListResponseSchema
>;

const designCatalogMutationBaseShape = {
  request_id: designUuidSchema,
  scope: designResourceScopeSchema,
  workspace_id: designUuidSchema.nullable(),
} as const;

export const createDesignResourceRequestSchema = z
  .object({
    ...designCatalogMutationBaseShape,
    kind: designResourceKindSchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).nullable(),
    asset_object_id: designUuidSchema,
    preview_asset_object_id: designUuidSchema.nullable(),
    category_id: designUuidSchema.nullable(),
    tag_ids: uniqueUuidArraySchema,
    ...catalogAttributionShape,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type CreateDesignResourceRequest = z.infer<
  typeof createDesignResourceRequestSchema
>;

export const updateDesignResourceRequestSchema = z
  .object({
    request_id: designUuidSchema,
    resource_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2_000).nullable().optional(),
    preview_asset_object_id: designUuidSchema.nullable().optional(),
    category_id: designUuidSchema.nullable().optional(),
    tag_ids: uniqueUuidArraySchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) =>
          !["request_id", "resource_id", "expected_revision"].includes(key),
      ),
    "resource update must not be empty",
  );
export type UpdateDesignResourceRequest = z.infer<
  typeof updateDesignResourceRequestSchema
>;

export const createDesignTemplateRequestSchema = z
  .object({
    ...designCatalogMutationBaseShape,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).nullable(),
    scene: loomicSceneV1Schema,
    preview_asset_object_id: designUuidSchema.nullable(),
    category_id: designUuidSchema.nullable(),
    tag_ids: uniqueUuidArraySchema,
    ...catalogAttributionShape,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type CreateDesignTemplateRequest = z.infer<
  typeof createDesignTemplateRequestSchema
>;

export const designCatalogEntityKindSchema = z.enum([
  "resource",
  "template",
  "text_preset",
  "font_family",
  "font_face",
  "category",
  "tag",
]);

export const setDesignCatalogStatusRequestSchema = z
  .object({
    request_id: designUuidSchema,
    entity_kind: designCatalogEntityKindSchema,
    entity_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    status: designCatalogStatusSchema,
  })
  .strict();
export type SetDesignCatalogStatusRequest = z.infer<
  typeof setDesignCatalogStatusRequestSchema
>;

export const deleteDesignCatalogEntryRequestSchema = z
  .object({
    request_id: designUuidSchema,
    entity_kind: designCatalogEntityKindSchema,
    entity_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
export type DeleteDesignCatalogEntryRequest = z.infer<
  typeof deleteDesignCatalogEntryRequestSchema
>;

export const restoreDesignCatalogEntryRequestSchema =
  deleteDesignCatalogEntryRequestSchema;
export type RestoreDesignCatalogEntryRequest = z.infer<
  typeof restoreDesignCatalogEntryRequestSchema
>;

export const designCatalogMutationResponseSchema = z
  .object({
    entity_kind: designCatalogEntityKindSchema,
    entity_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    status: designCatalogStatusSchema,
    replayed: z.boolean(),
  })
  .strict();
export type DesignCatalogMutationResponse = z.infer<
  typeof designCatalogMutationResponseSchema
>;

const designCatalogUpdateIdentityShape = {
  request_id: designUuidSchema,
  entity_id: designUuidSchema,
  expected_revision: z.number().int().nonnegative(),
} as const;

const nonEmptyCatalogUpdate = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({ ...designCatalogUpdateIdentityShape, ...shape })
    .strict()
    .refine(
      (value) =>
        Object.keys(value).some(
          (key) =>
            !["request_id", "entity_id", "expected_revision"].includes(key),
        ),
      "catalog update must not be empty",
    );

export const updateDesignTemplateRequestSchema = nonEmptyCatalogUpdate({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2_000).nullable().optional(),
  scene: loomicSceneV1Schema.optional(),
  preview_asset_object_id: designUuidSchema.nullable().optional(),
  category_id: designUuidSchema.nullable().optional(),
  tag_ids: uniqueUuidArraySchema.optional(),
  ...Object.fromEntries(
    Object.entries(catalogAttributionShape).map(([key, schema]) => [
      key,
      schema.optional(),
    ]),
  ),
});
export type UpdateDesignTemplateRequest = z.infer<
  typeof updateDesignTemplateRequestSchema
>;

export const createDesignTextPresetRequestSchema = z
  .object({
    ...designCatalogMutationBaseShape,
    name: z.string().trim().min(1).max(200),
    style: designTextPresetContentSchema,
    preview_asset_object_id: designUuidSchema.nullable(),
    category_id: designUuidSchema.nullable(),
    tag_ids: uniqueUuidArraySchema,
    ...catalogAttributionShape,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type CreateDesignTextPresetRequest = z.infer<
  typeof createDesignTextPresetRequestSchema
>;

export const updateDesignTextPresetRequestSchema = nonEmptyCatalogUpdate({
  name: z.string().trim().min(1).max(200).optional(),
  style: designTextPresetContentSchema.optional(),
  preview_asset_object_id: designUuidSchema.nullable().optional(),
  category_id: designUuidSchema.nullable().optional(),
  tag_ids: uniqueUuidArraySchema.optional(),
});
export type UpdateDesignTextPresetRequest = z.infer<
  typeof updateDesignTextPresetRequestSchema
>;

export const createDesignFontFamilyRequestSchema = z
  .object({
    ...designCatalogMutationBaseShape,
    name: z.string().trim().min(1).max(200),
    ...catalogAttributionShape,
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type CreateDesignFontFamilyRequest = z.infer<
  typeof createDesignFontFamilyRequestSchema
>;

export const updateDesignFontFamilyRequestSchema = nonEmptyCatalogUpdate({
  name: z.string().trim().min(1).max(200).optional(),
  ...Object.fromEntries(
    Object.entries(catalogAttributionShape).map(([key, schema]) => [
      key,
      schema.optional(),
    ]),
  ),
});
export type UpdateDesignFontFamilyRequest = z.infer<
  typeof updateDesignFontFamilyRequestSchema
>;

export const createDesignFontFaceRequestSchema = z
  .object({
    ...designCatalogMutationBaseShape,
    family_id: designUuidSchema,
    asset_object_id: designUuidSchema,
    style: z.enum(["normal", "italic", "oblique"]),
    weight: z.number().int().min(1).max(1_000),
    format: z.enum(["woff2", "woff", "ttf", "otf"]),
    checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    allow_web_embed: z.boolean(),
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type CreateDesignFontFaceRequest = z.infer<
  typeof createDesignFontFaceRequestSchema
>;

export const updateDesignFontFaceRequestSchema = nonEmptyCatalogUpdate({
  style: z.enum(["normal", "italic", "oblique"]).optional(),
  weight: z.number().int().min(1).max(1_000).optional(),
  allow_web_embed: z.boolean().optional(),
});
export type UpdateDesignFontFaceRequest = z.infer<
  typeof updateDesignFontFaceRequestSchema
>;

export const createDesignCategoryRequestSchema = z
  .object({
    ...designCatalogMutationBaseShape,
    parent_id: designUuidSchema.nullable(),
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().min(1).max(120),
    sort_order: z.number().int(),
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type CreateDesignCategoryRequest = z.infer<
  typeof createDesignCategoryRequestSchema
>;

export const updateDesignCategoryRequestSchema = nonEmptyCatalogUpdate({
  parent_id: designUuidSchema.nullable().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(1).max(120).optional(),
  sort_order: z.number().int().optional(),
});
export type UpdateDesignCategoryRequest = z.infer<
  typeof updateDesignCategoryRequestSchema
>;

export const createDesignTagRequestSchema = z
  .object({
    ...designCatalogMutationBaseShape,
    name: z.string().trim().min(1).max(80),
    slug: z.string().trim().min(1).max(80),
  })
  .strict()
  .superRefine(validateScopeWorkspace);
export type CreateDesignTagRequest = z.infer<
  typeof createDesignTagRequestSchema
>;

export const updateDesignTagRequestSchema = nonEmptyCatalogUpdate({
  name: z.string().trim().min(1).max(80).optional(),
  slug: z.string().trim().min(1).max(80).optional(),
});
export type UpdateDesignTagRequest = z.infer<
  typeof updateDesignTagRequestSchema
>;

export const designCatalogListRequestSchema = z
  .object({
    entity_kind: designCatalogEntityKindSchema,
    scope: designResourceScopeSchema.optional(),
    workspace_id: designUuidSchema.optional(),
    status: designCatalogStatusSchema.optional(),
    query: z.string().trim().max(200).optional(),
    category_id: designUuidSchema.optional(),
    tag_id: designUuidSchema.optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export type DesignCatalogListRequest = z.infer<
  typeof designCatalogListRequestSchema
>;

export const designCatalogListResponseSchema = z
  .object({
    items: z.array(
      z.union([
        designResourceDtoSchema,
        designTemplateDtoSchema,
        designTextPresetDtoSchema,
        designFontFamilyDtoSchema,
        designFontFaceDtoSchema,
        designResourceCategoryDtoSchema,
        designResourceTagDtoSchema,
      ]),
    ),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type DesignCatalogListResponse = z.infer<
  typeof designCatalogListResponseSchema
>;

export const setDesignResourceFavoriteRequestSchema = z
  .object({ resource_id: designUuidSchema, favorite: z.boolean() })
  .strict();
export type SetDesignResourceFavoriteRequest = z.infer<
  typeof setDesignResourceFavoriteRequestSchema
>;

export const setDesignResourceFavoriteResponseSchema = z
  .object({ resource_id: designUuidSchema, favorite: z.boolean() })
  .strict();
export type SetDesignResourceFavoriteResponse = z.infer<
  typeof setDesignResourceFavoriteResponseSchema
>;

export const recordDesignResourceRecentUseRequestSchema = z
  .object({ resource_id: designUuidSchema, workspace_id: designUuidSchema })
  .strict();
export type RecordDesignResourceRecentUseRequest = z.infer<
  typeof recordDesignResourceRecentUseRequestSchema
>;

export const recordDesignResourceRecentUseResponseSchema = z
  .object({
    resource_id: designUuidSchema,
    workspace_id: designUuidSchema,
    used_at: timestampSchema,
    use_count: z.number().int().positive(),
  })
  .strict();
export type RecordDesignResourceRecentUseResponse = z.infer<
  typeof recordDesignResourceRecentUseResponseSchema
>;

export const designImportSourceKindSchema = z.enum([
  "local_upload",
  "url",
  "manifest",
]);
export const designImportKindSchema = designImportSourceKindSchema;
export type DesignImportSourceKind = z.infer<
  typeof designImportSourceKindSchema
>;
export type DesignImportKind = DesignImportSourceKind;

const importRequestScopeShape = {
  request_id: designUuidSchema,
  scope: designResourceScopeSchema,
  workspace_id: designUuidSchema.nullable(),
} as const;

const localUploadImportRequestSchema = z
  .object({
    ...importRequestScopeShape,
    source_kind: z.literal("local_upload"),
    asset_object_ids: z
      .array(designUuidSchema)
      .min(1)
      .max(100)
      .superRefine((values, context) =>
        addDuplicateIssues(values, context, []),
      ),
  })
  .strict()
  .superRefine(validateScopeWorkspace);

const urlImportRequestSchema = z
  .object({
    ...importRequestScopeShape,
    source_kind: z.literal("url"),
    source_urls: z
      .array(z.string().url())
      .min(1)
      .max(100)
      .superRefine((values, context) =>
        addDuplicateIssues(values, context, []),
      ),
  })
  .strict()
  .superRefine(validateScopeWorkspace);

const manifestImportRequestSchema = z
  .object({
    ...importRequestScopeShape,
    source_kind: z.literal("manifest"),
    manifest_asset_object_id: designUuidSchema,
  })
  .strict()
  .superRefine(validateScopeWorkspace);

export const designInlineManifestItemSchema = z
  .object({
    source_key: z.string().trim().min(1).max(500),
    entity_kind: designCatalogEntityKindSchema,
    asset_object_id: designUuidSchema.nullable().optional(),
    source_url: z.string().url().optional(),
    depends_on: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((item, context) => {
    const needsBinary = ["resource", "font_face"].includes(item.entity_kind);
    const sourceCount =
      (item.asset_object_id ? 1 : 0) + (item.source_url ? 1 : 0);
    if (
      (needsBinary && sourceCount !== 1) ||
      (!needsBinary && sourceCount !== 0)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: needsBinary
          ? "binary manifest items require exactly one source"
          : "metadata-only manifest items cannot declare a binary source",
      });
  });

export const inlineDesignImportRequestSchema = z
  .object({
    ...importRequestScopeShape,
    source_kind: z.literal("manifest_inline"),
    manifest: z
      .object({
        version: z.literal(1),
        items: z.array(designInlineManifestItemSchema).min(1).max(100),
      })
      .strict(),
  })
  .strict()
  .superRefine(validateScopeWorkspace);

// Refined members require a regular union in Zod v3. Their literal
// source_kind and strict source fields still make the variants exclusive.
export const createDesignImportRequestSchema = z.union([
  localUploadImportRequestSchema,
  urlImportRequestSchema,
  manifestImportRequestSchema,
  inlineDesignImportRequestSchema,
]);
export type CreateDesignImportRequest = z.infer<
  typeof createDesignImportRequestSchema
>;

export const createDesignImportResponseSchema = z
  .object({
    import_job_id: designUuidSchema,
    status: z.literal("queued"),
    replayed: z.boolean(),
  })
  .strict();
export type CreateDesignImportResponse = z.infer<
  typeof createDesignImportResponseSchema
>;

export const designImportJobDtoSchema = z
  .object({
    id: designUuidSchema,
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    source_kind: designImportSourceKindSchema,
    request_id: designUuidSchema.nullable(),
    background_job_id: designUuidSchema.nullable(),
    status: z.enum(["queued", "running", "completed", "failed", "canceled"]),
    total_items: z.number().int().nonnegative(),
    completed_items: z.number().int().nonnegative(),
    failed_items: z.number().int().nonnegative(),
    created_by: designUuidSchema.nullable(),
    created_at: timestampSchema,
    started_at: timestampSchema.nullable(),
    completed_at: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    validateScopeWorkspace(value, context);
    if (value.completed_items + value.failed_items > value.total_items) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "import item counters exceed total",
        path: ["total_items"],
      });
    }
  });
export type DesignImportJobDto = z.infer<typeof designImportJobDtoSchema>;

export const designImportItemDtoSchema = z
  .object({
    id: designUuidSchema,
    import_job_id: designUuidSchema,
    source_key: z.string().trim().min(1).max(500),
    status: z.enum([
      "pending",
      "running",
      "imported",
      "duplicate",
      "failed",
      "rejected",
    ]),
    result_entity_kind: designCatalogEntityKindSchema.nullable(),
    result_entity_id: designUuidSchema.nullable(),
    resource_id: designUuidSchema.nullable(),
    asset_object_id: designUuidSchema.nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: timestampSchema,
    completed_at: timestampSchema.nullable(),
  })
  .strict();
export type DesignImportItemDto = z.infer<typeof designImportItemDtoSchema>;

export const jobTargetFinalizationDtoSchema = z
  .object({
    id: designUuidSchema,
    job_id: designUuidSchema,
    workspace_id: designUuidSchema,
    target_kind: z.enum(["canvas", "design"]),
    target_id: designUuidSchema,
    status: z.enum([
      "pending",
      "running",
      "completed",
      "needs_attention",
      "failed",
    ]),
    command_id: designUuidSchema,
    result: z.record(z.string(), z.unknown()).nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    attempt_count: z.number().int().nonnegative(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    completed_at: timestampSchema.nullable(),
  })
  .strict();
export type JobTargetFinalizationDto = z.infer<
  typeof jobTargetFinalizationDtoSchema
>;

export const designEventOutboxDtoSchema = z
  .object({
    id: designUuidSchema,
    design_id: designUuidSchema,
    workspace_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    event_type: z.enum([
      "design.sync",
      "design.deleted",
      "design.restored",
      "design.preview",
    ]),
    payload: z.union([
      designSyncEventSchema,
      z
        .object({
          type: z.literal("design.deleted"),
          designId: designUuidSchema,
          revision: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          type: z.literal("design.restored"),
          designId: designUuidSchema,
          revision: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          type: z.literal("design.preview"),
          designId: designUuidSchema,
          revision: z.number().int().nonnegative(),
          previewAssetObjectId: designUuidSchema,
          previewRevision: z.number().int().nonnegative(),
        })
        .strict()
        .refine((value) => value.previewRevision <= value.revision, {
          message: "preview revision cannot exceed document revision",
          path: ["previewRevision"],
        }),
    ]),
    status: z.enum(["pending", "publishing", "published", "failed"]),
    attempt_count: z.number().int().nonnegative(),
    available_at: timestampSchema,
    claimed_at: timestampSchema.nullable(),
    claim_token: designUuidSchema.nullable(),
    published_at: timestampSchema.nullable(),
    last_error: z.string().nullable(),
    created_at: timestampSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.payload.type === value.event_type &&
      value.payload.designId === value.design_id &&
      value.payload.revision === value.revision,
    { message: "outbox envelope and payload must identify the same revision" },
  );
export type DesignEventOutboxDto = z.infer<typeof designEventOutboxDtoSchema>;

export const agentDesignToolNameSchema = z.enum([
  "inspect_design",
  "get_design_objects",
  "manipulate_design",
  "search_design_resources",
  "apply_design_template",
  "export_design",
]);
export type AgentDesignToolName = z.infer<typeof agentDesignToolNameSchema>;

export const agentDesignToolExecutionContextSchema = z
  .object({
    actor_kind: z.literal("agent"),
    actor_user_id: designUuidSchema,
    agent_run_id: designUuidSchema,
    tool_execution_id: designUuidSchema,
  })
  .strict();
export type AgentDesignToolExecutionContext = z.infer<
  typeof agentDesignToolExecutionContextSchema
>;

export const agentDesignToolAuditSchema = agentDesignToolExecutionContextSchema;
export type AgentDesignToolAudit = AgentDesignToolExecutionContext;

export const agentDesignDestructiveConfirmationSchema = z
  .object({
    confirmation_id: designUuidSchema,
    confirmed: z.literal(true),
  })
  .strict();
export type AgentDesignDestructiveConfirmation = z.infer<
  typeof agentDesignDestructiveConfirmationSchema
>;

export const agentDesignObjectSummarySchema = z
  .object({
    z_index: z.number().int().nonnegative().optional(),
    locked: z.boolean().optional(),
    visible: z.boolean().optional(),
    child_object_ids: z.array(designUuidSchema).optional(),
    asset_object_id: designUuidSchema.optional(),
    object_id: designUuidSchema,
    object_version: z.number().int().positive(),
    type: designObjectTypeSchema,
    role: designObjectRoleSchema.nullable(),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: positiveFiniteNumberSchema,
    height: positiveFiniteNumberSchema,
    text: z.string().max(500).optional(),
    resource_id: designUuidSchema.nullable().optional(),
  })
  .strict();
export type AgentDesignObjectSummary = z.infer<
  typeof agentDesignObjectSummarySchema
>;

export const agentDesignToolErrorCodeSchema = z.enum([
  "design_not_found",
  "design_forbidden",
  "design_revision_conflict",
  "design_object_version_conflict",
  "template_not_found",
  "template_revision_conflict",
  "resource_not_found",
  "validation_error",
  "job_unavailable",
  "internal_error",
]);
export type AgentDesignToolErrorCode = z.infer<
  typeof agentDesignToolErrorCodeSchema
>;

export const agentDesignToolErrorOutputSchema = z
  .object({
    status: z.literal("error"),
    code: agentDesignToolErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    current_revision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.code === "design_revision_conflict" ||
        value.code === "template_revision_conflict") &&
      value.current_revision === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "revision conflicts must include the authoritative revision",
        path: ["current_revision"],
      });
    }
  });
export type AgentDesignToolErrorOutput = z.infer<
  typeof agentDesignToolErrorOutputSchema
>;

const agentDesignUniqueObjectIdsSchema = (maximum: number, minimum = 0) =>
  z
    .array(designUuidSchema)
    .min(minimum)
    .max(maximum)
    .superRefine((values, context) => addDuplicateIssues(values, context, []));

export const inspectDesignToolInputSchema = z
  .object({
    design_id: designUuidSchema,
    offset: z.number().int().nonnegative().optional(),
    expected_revision: z.number().int().nonnegative().optional(),
    selection_object_ids: agentDesignUniqueObjectIdsSchema(100).default([]),
    object_limit: z.number().int().min(1).max(100).default(50),
    text_limit: z.number().int().min(16).max(500).default(160),
  })
  .strict();
export type InspectDesignToolInput = z.infer<
  typeof inspectDesignToolInputSchema
>;

const inspectDesignToolSuccessOutputSchema = z
  .object({
    next_offset: z.number().int().nonnegative().nullable().optional(),
    design_id: designUuidSchema,
    name: z.string().trim().min(1).max(200),
    width: designDimensionSchema,
    height: designDimensionSchema,
    revision: z.number().int().nonnegative(),
    object_count: z.number().int().nonnegative(),
    objects: z.array(agentDesignObjectSummarySchema).max(100),
    selection_object_ids: agentDesignUniqueObjectIdsSchema(100),
    truncated: z.boolean(),
  })
  .strict()
  .refine((value) => value.objects.length <= value.object_count, {
    message: "design summary cannot contain more objects than the design",
    path: ["objects"],
  });
export const inspectDesignToolOutputSchema = z.union([
  inspectDesignToolSuccessOutputSchema,
  agentDesignToolErrorOutputSchema,
]);
export type InspectDesignToolOutput = z.infer<
  typeof inspectDesignToolOutputSchema
>;

export const getDesignObjectsToolInputSchema = z
  .object({
    design_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    object_ids: agentDesignUniqueObjectIdsSchema(10, 1),
  })
  .strict();
export type GetDesignObjectsToolInput = z.infer<
  typeof getDesignObjectsToolInputSchema
>;

const getDesignObjectsToolSuccessOutputSchema = z
  .object({
    design_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    objects: z.array(designObjectSchema).max(50),
    missing_object_ids: agentDesignUniqueObjectIdsSchema(10),
  })
  .strict();
export const getDesignObjectsToolOutputSchema = z.union([
  getDesignObjectsToolSuccessOutputSchema,
  agentDesignToolErrorOutputSchema,
]);
export type GetDesignObjectsToolOutput = z.infer<
  typeof getDesignObjectsToolOutputSchema
>;

export const manipulateDesignToolInputSchema = z
  .object({
    design_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    commands: z.array(designCommandSchema).min(1).max(500),
  })
  .strict();
export type ManipulateDesignToolInput = z.infer<
  typeof manipulateDesignToolInputSchema
>;

// Provider-facing variant: keep the command item opaque so model providers do
// not merge mutually exclusive fields across the full command union. Agent
// handlers must parse the result again with manipulateDesignToolInputSchema.
export const manipulateDesignModelInputSchema = z
  .object({
    design_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    commands: z.array(z.unknown()).min(1).max(500),
  })
  .strict();

const agentDesignConfirmationRequiredOutputShape = {
  status: z.literal("confirmation_required"),
  design_id: designUuidSchema,
  expected_revision: z.number().int().nonnegative(),
  confirmation_id: designUuidSchema,
  summary: z.string().trim().min(1).max(500),
  affected_object_ids: agentDesignUniqueObjectIdsSchema(100),
  expires_at: timestampSchema,
} as const;

export const manipulateDesignToolOutputSchema = z.union([
  designMutationResponseSchema
    .extend({ status: z.literal("applied") })
    .strict(),
  z.object(agentDesignConfirmationRequiredOutputShape).strict(),
  agentDesignToolErrorOutputSchema,
]);
export type ManipulateDesignToolOutput = z.infer<
  typeof manipulateDesignToolOutputSchema
>;

export const searchDesignResourcesToolInputSchema = z
  .object({
    workspace_id: designUuidSchema,
    query: z.string().trim().min(1).max(200).optional(),
    kind: designResourceKindSchema.optional(),
    category_id: designUuidSchema.optional(),
    tag_id: designUuidSchema.optional(),
    cursor: z.string().trim().min(1).max(1_024).optional(),
    limit: z.number().int().min(1).max(30).default(20),
    summary_max_chars: z.number().int().min(40).max(500).default(240),
  })
  .strict();
export type SearchDesignResourcesToolInput = z.infer<
  typeof searchDesignResourcesToolInputSchema
>;

export const agentDesignResourceSummarySchema = z
  .object({
    id: designUuidSchema,
    scope: designResourceScopeSchema,
    workspace_id: designUuidSchema.nullable(),
    kind: designResourceKindSchema,
    name: z.string().trim().min(1).max(200),
    summary: z.string().max(500).nullable(),
    width: designDimensionSchema.nullable(),
    height: designDimensionSchema.nullable(),
    preview_asset_object_id: designUuidSchema.nullable(),
    category_id: designUuidSchema.nullable(),
    tag_ids: agentDesignUniqueObjectIdsSchema(50),
  })
  .strict();
export type AgentDesignResourceSummary = z.infer<
  typeof agentDesignResourceSummarySchema
>;

const searchDesignResourcesToolSuccessOutputSchema = z
  .object({
    items: z.array(agentDesignResourceSummarySchema).max(30),
    next_cursor: z.string().max(1_024).nullable(),
    truncated: z.boolean(),
  })
  .strict();
export const searchDesignResourcesToolOutputSchema = z.union([
  searchDesignResourcesToolSuccessOutputSchema,
  agentDesignToolErrorOutputSchema,
]);
export type SearchDesignResourcesToolOutput = z.infer<
  typeof searchDesignResourcesToolOutputSchema
>;

export const applyDesignTemplateToolInputSchema = z
  .object({
    design_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    template_id: designUuidSchema,
    expected_template_revision: z.number().int().nonnegative(),
    mode: z.literal("replace"),
  })
  .strict();
export type ApplyDesignTemplateToolInput = z.infer<
  typeof applyDesignTemplateToolInputSchema
>;

export const applyDesignTemplateToolOutputSchema = z.union([
  designMutationResponseSchema
    .extend({
      status: z.literal("applied"),
      template_id: designUuidSchema,
    })
    .strict(),
  z
    .object({
      ...agentDesignConfirmationRequiredOutputShape,
      template_id: designUuidSchema,
    })
    .strict(),
  agentDesignToolErrorOutputSchema,
]);
export type ApplyDesignTemplateToolOutput = z.infer<
  typeof applyDesignTemplateToolOutputSchema
>;

export const exportDesignToolInputSchema = z
  .object({
    design_id: designUuidSchema,
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: designUuidSchema,
    format: designExportFormatSchema,
    multiplier: z.union([z.literal(1), z.literal(2)]),
    transparent: z.boolean(),
  })
  .strict()
  .refine((value) => value.format === "png" || !value.transparent, {
    message: "JPEG export cannot be transparent",
    path: ["transparent"],
  });
export type ExportDesignToolInput = z.infer<typeof exportDesignToolInputSchema>;

const exportDesignToolSuccessOutputSchema = z
  .object({
    design_id: designUuidSchema,
    revision: z.number().int().nonnegative(),
    job_id: designUuidSchema,
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "canceled",
      "dead_letter",
    ]),
    replayed: z.boolean(),
  })
  .strict();
export const exportDesignToolOutputSchema = z.union([
  exportDesignToolSuccessOutputSchema,
  agentDesignToolErrorOutputSchema,
]);
export type ExportDesignToolOutput = z.infer<
  typeof exportDesignToolOutputSchema
>;

export const platformAdminDtoSchema = z
  .object({
    user_id: designUuidSchema,
    is_active: z.boolean(),
    granted_by: designUuidSchema.nullable(),
    granted_at: timestampSchema,
    revoked_at: timestampSchema.nullable(),
  })
  .strict()
  .refine((value) => !value.is_active || value.revoked_at === null, {
    message: "an active platform admin cannot have a revoked timestamp",
    path: ["revoked_at"],
  });
export type PlatformAdminDto = z.infer<typeof platformAdminDtoSchema>;
