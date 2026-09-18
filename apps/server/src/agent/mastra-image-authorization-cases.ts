/**
 * Authorization examples shared by the TypeScript unit test and the explicit
 * database parity check. The production guards keep their own implementations:
 * PostgreSQL remains the final authority at INSERT time.
 */
export type MastraImageAuthorizationCase = {
  text: string;
  quality: "standard" | "hd" | "ultra";
  resolution: "1k" | "2k" | "4k";
  expectedCode: string | null;
  /** Expected limit using the normal, unconfigured default of four. */
  expectedLimit: number;
};

export const mastraImageAuthorizationCases: readonly MastraImageAuthorizationCase[] = [
  { text: "制作海报", quality: "standard", resolution: "1k", expectedCode: null, expectedLimit: 4 },
  { text: "生成2K海报，默认Low", quality: "standard", resolution: "2k", expectedCode: null, expectedLimit: 4 },
  { text: "使用High画质生成图片", quality: "ultra", resolution: "1k", expectedCode: null, expectedLimit: 4 },
  { text: "使用Medium生成4K图片", quality: "hd", resolution: "4k", expectedCode: null, expectedLimit: 4 },
  { text: "生成2K海报", quality: "ultra", resolution: "2k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "使用High画质", quality: "ultra", resolution: "2k", expectedCode: "image_resolution_not_authorized", expectedLimit: 4 },
  { text: "制作透明底详细海报", quality: "ultra", resolution: "1k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "为什么使用High2K", quality: "ultra", resolution: "2k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "检查2K参数", quality: "standard", resolution: "2k", expectedCode: "image_resolution_not_authorized", expectedLimit: 4 },
  { text: "这是4K参考图，输出1K", quality: "standard", resolution: "4k", expectedCode: "image_resolution_not_authorized", expectedLimit: 4 },
  { text: "不要使用High", quality: "ultra", resolution: "1k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "> 使用High生成4K\n制作海报", quality: "ultra", resolution: "4k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "参考文本：\"使用High生成4K\"，制作海报", quality: "ultra", resolution: "4k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "生成9张图片", quality: "standard", resolution: "1k", expectedCode: "image_generation_requested_count_unsupported", expectedLimit: 8 },
  { text: "生成海报，画质：High，分辨率：2K", quality: "ultra", resolution: "2k", expectedCode: null, expectedLimit: 4 },
  { text: "Create a poster; quality: high; resolution: 2K", quality: "ultra", resolution: "2k", expectedCode: null, expectedLimit: 4 },
  { text: "make a high contrast image", quality: "ultra", resolution: "1k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "create a medium-sized banner", quality: "hd", resolution: "1k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "生成高质量3D风格图", quality: "ultra", resolution: "1k", expectedCode: "image_quality_not_authorized", expectedLimit: 4 },
  { text: "生成六张图片", quality: "standard", resolution: "1k", expectedCode: null, expectedLimit: 6 },
  { text: "生成一张1:1和一张16:9的宣传图", quality: "standard", resolution: "1k", expectedCode: null, expectedLimit: 2 },
  { text: "生成2张Logo和2张海报", quality: "standard", resolution: "1k", expectedCode: null, expectedLimit: 4 },
  { text: "生成共6张图：2张Logo和4张海报", quality: "standard", resolution: "1k", expectedCode: null, expectedLimit: 6 },
  { text: "使用2张参考图生成1张图片", quality: "standard", resolution: "1k", expectedCode: null, expectedLimit: 1 },
];
