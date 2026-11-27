'use strict';
const mediaGen = require('../media-gen');
const docStudio = require('../doc-studio');

const mediaDocToolDefinitions = [
  {
    name: 'GenerateImage',
    description: 'Generate an image from a text prompt using the best configured image model (Gemini Imagen/Flash-Image, OpenAI gpt-image-1/DALL-E 3, xAI/Together/Flux, local ComfyUI/A1111, or built-in offline SVG/Canvas studio). Saves into the workspace and emits an inline studio preview.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        output_path: { type: 'string' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3'] },
        format: { type: 'string', enum: ['png', 'webp', 'jpg', 'svg'] },
        style: { type: 'string' },
        model: { type: 'string' },
        count: { type: 'number' },
        cwd: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'create_image',
    description: 'Alias of GenerateImage: generate an image from a text prompt.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        output_path: { type: 'string' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3'] },
        format: { type: 'string', enum: ['png', 'webp', 'jpg', 'svg'] },
        style: { type: 'string' },
        model: { type: 'string' },
        count: { type: 'number' },
        cwd: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'EditImage',
    description: 'Edit, transform, resize, crop, convert (png/webp/jpg/avif/ico), remove background, upscale, watermark, annotate, or OCR an image.',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string' },
        output_path: { type: 'string' },
        operation: { type: 'string', enum: ['ai_edit', 'inpaint', 'remove_background', 'upscale', 'resize', 'crop', 'convert', 'watermark', 'annotate', 'ocr'] },
        instruction: { type: 'string' },
        mask_path: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        crop_box: { description: 'Object {x,y,width,height} or [x,y,w,h]' },
        format: { type: 'string' },
        watermark_text: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['input_path', 'operation'],
    },
  },
  {
    name: 'edit_image',
    description: 'Alias of EditImage.',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string' },
        output_path: { type: 'string' },
        operation: { type: 'string', enum: ['ai_edit', 'inpaint', 'remove_background', 'upscale', 'resize', 'crop', 'convert', 'watermark', 'annotate', 'ocr'] },
        instruction: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        crop_box: {},
        format: { type: 'string' },
        watermark_text: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['input_path', 'operation'],
    },
  },
  {
    name: 'GenerateVideo',
    description: 'Generate a video or motion graphic (.mp4, .webm, .gif) from a prompt, reference image (image-to-video), or HTML animation code via Veo/Sora/Fal/ComfyUI or built-in 30fps studio renderer.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        output_path: { type: 'string' },
        duration_sec: { type: 'number' },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
        fps: { type: 'number', enum: [24, 30] },
        image_path: { type: 'string' },
        html_animation_code: { type: 'string' },
        format: { type: 'string', enum: ['mp4', 'webm', 'gif'] },
        cwd: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description: 'Alias of GenerateVideo.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        output_path: { type: 'string' },
        duration_sec: { type: 'number' },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
        fps: { type: 'number' },
        image_path: { type: 'string' },
        format: { type: 'string', enum: ['mp4', 'webm', 'gif'] },
        cwd: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'EditVideo',
    description: 'Inspect, trim, concat, extract keyframes/contact sheet, extract/mux audio, burn SRT/VTT subtitles, resize, adjust speed, compress, or convert video to GIF using ffmpeg/ffprobe.',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string' },
        output_path: { type: 'string' },
        operation: { type: 'string', enum: ['trim', 'concat', 'extract_frames', 'extract_audio', 'add_audio', 'add_subtitles', 'resize', 'speed', 'to_gif', 'compress', 'inspect'] },
        start_sec: { type: 'number' },
        end_sec: { type: 'number' },
        extra_inputs: { type: 'array', items: { type: 'string' } },
        subtitles_srt: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        speed_factor: { type: 'number' },
        count: { type: 'number' },
        cwd: { type: 'string' },
      },
      required: ['input_path', 'operation'],
    },
  },
  {
    name: 'edit_video',
    description: 'Alias of EditVideo.',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string' },
        output_path: { type: 'string' },
        operation: { type: 'string', enum: ['trim', 'concat', 'extract_frames', 'extract_audio', 'add_audio', 'add_subtitles', 'resize', 'speed', 'to_gif', 'compress', 'inspect'] },
        start_sec: { type: 'number' },
        end_sec: { type: 'number' },
        extra_inputs: { type: 'array', items: { type: 'string' } },
        subtitles_srt: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        speed_factor: { type: 'number' },
        cwd: { type: 'string' },
      },
      required: ['input_path', 'operation'],
    },
  },
  {
    name: 'ReadDocument',
    description: 'Universally read PDF (with page range), Word (.docx), Excel/CSV (.xlsx/.csv/.ods with formulas), PowerPoint (.pptx slides + notes), EPUB/RTF/ODT, SQLite (.sqlite/.db), and ZIP/tar.gz archives cleanly offline.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        file_path: { type: 'string' },
        pages: { type: 'string', description: 'Optional PDF page range e.g. "1-3"' },
        sheet: { type: 'string', description: 'Optional Excel sheet name' },
        entry: { type: 'string', description: 'Optional archive entry path to preview' },
        extract_images: { type: 'boolean' },
        format: { type: 'string', enum: ['markdown', 'json', 'text'] },
        cwd: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_document',
    description: 'Alias of ReadDocument: universally read PDF, Word, Excel/CSV, PowerPoint, EPUB/RTF/ODT, SQLite, or ZIP/tar.gz archives.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        file_path: { type: 'string' },
        pages: { type: 'string' },
        sheet: { type: 'string' },
        entry: { type: 'string' },
        extract_images: { type: 'boolean' },
        format: { type: 'string', enum: ['markdown', 'json', 'text'] },
        cwd: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'GenerateDocument',
    description: 'Create or transform .pdf (from markdown/sections, merge, watermark, stamp page numbers), LaTeX (.tex -> .pdf), Word (.docx), multi-sheet Excel with live formulas (.xlsx), PowerPoint (.pptx), or .zip archives offline.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'pptx', 'zip', 'tex', 'latex', 'latex_pdf'] },
        output_path: { type: 'string' },
        title: { type: 'string' },
        markdown: { type: 'string' },
        content: { type: 'string' },
        latex: { type: 'string' },
        sections: { type: 'array', items: { type: 'object' } },
        sheets: { type: 'array', items: { type: 'object' } },
        slides: { type: 'array', items: { type: 'object' } },
        files: { type: 'array' },
        source_dir: { type: 'string' },
        merge_paths: { type: 'array', items: { type: 'string' } },
        input_path: { type: 'string' },
        watermark: { type: 'string' },
        stamp_page_numbers: { type: 'boolean' },
        spec: { type: 'object' },
        cwd: { type: 'string' },
      },
      required: ['format'],
    },
  },
  {
    name: 'generate_document',
    description: 'Alias of GenerateDocument: generate .pdf, .docx, .xlsx, .pptx, .zip, or compiled LaTeX .pdf offline.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'pptx', 'zip', 'tex', 'latex', 'latex_pdf'] },
        output_path: { type: 'string' },
        title: { type: 'string' },
        markdown: { type: 'string' },
        content: { type: 'string' },
        latex: { type: 'string' },
        sections: { type: 'array', items: { type: 'object' } },
        sheets: { type: 'array', items: { type: 'object' } },
        slides: { type: 'array', items: { type: 'object' } },
        files: { type: 'array' },
        source_dir: { type: 'string' },
        merge_paths: { type: 'array', items: { type: 'string' } },
        input_path: { type: 'string' },
        watermark: { type: 'string' },
        stamp_page_numbers: { type: 'boolean' },
        spec: { type: 'object' },
        cwd: { type: 'string' },
      },
      required: ['format'],
    },
  },
];

const mediaDocExecutors = {
  async generate_image(args, execCtx) {
    const r = await mediaGen.generateImage(args, execCtx || {});
    return JSON.stringify(r, null, 2);
  },
  async edit_image(args, execCtx) {
    const r = await mediaGen.editImage(args, execCtx || {});
    return JSON.stringify(r, null, 2);
  },
  async generate_video(args, execCtx) {
    const r = await mediaGen.generateVideo(args, execCtx || {});
    return JSON.stringify(r, null, 2);
  },
  async edit_video(args, execCtx) {
    const r = await mediaGen.editVideo(args, execCtx || {});
    return JSON.stringify(r, null, 2);
  },
  async read_document(args, execCtx) {
    const fp = args.path || args.file_path;
    if (!fp) return 'Error: ReadDocument requires "path".';
    const r = await docStudio.readDocument(fp, {
      cwd: args.cwd || (execCtx && execCtx.cwd) || process.cwd(),
      pages: args.pages,
      sheet: args.sheet,
      entry: args.entry,
      extract_images: Boolean(args.extract_images),
      format: args.format,
    });
    if (args.format === 'json') return JSON.stringify(r, null, 2);
    if (args.format === 'text') return r.text || r.markdown || JSON.stringify(r, null, 2);
    return r.markdown || r.text || JSON.stringify(r, null, 2);
  },
  async generate_document(args, execCtx) {
    const r = await docStudio.generateDocument(args, execCtx || {});
    return JSON.stringify(r, null, 2);
  },
};

const mediaDocExecutorsByTool = {
  GenerateImage: 'generate_image',
  create_image: 'generate_image',
  EditImage: 'edit_image',
  edit_image: 'edit_image',
  GenerateVideo: 'generate_video',
  generate_video: 'generate_video',
  EditVideo: 'edit_video',
  edit_video: 'edit_video',
  ReadDocument: 'read_document',
  read_document: 'read_document',
  GenerateDocument: 'generate_document',
  generate_document: 'generate_document',
};

module.exports = {
  mediaDocToolDefinitions,
  mediaDocExecutors,
  mediaDocExecutorsByTool,
};
