"""Papers, projects (composition model 03 §3.3), render requests/results."""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Union

from pydantic import Field

from .common import Margins, Model, OpenModel, OriginSpec, PrintOverrides


# ---------------------------------------------------------------- papers
class Ruling(Model):
    line_num: int = Field(20, ge=1, le=200, description='text lines per page (PageInfo.lineNum)')
    line_gap: float = 0.0
    line_gap_offset: float = 0.0
    base_line: float = 1.0


class PaperBase(Model):
    name: str = Field(min_length=1, max_length=80)
    width_mm: float = Field(gt=0, le=2000, description='sheet width as entered (portrait)')
    height_mm: float = Field(gt=0, le=2000)
    margins: Margins = Margins()
    orientation: Literal['portrait', 'landscape'] = Field(
        'portrait', description='landscape swaps width/height for layout')
    rotation: Literal[0, 90, 180, 270] = Field(0, description='page rotation onto the machine')
    ruling: Ruling = Ruling()


class PaperSpec(PaperBase):
    id: str
    builtin: bool = False


class PaperRef(Model):
    """Reference to a stored paper, or an inline spec (then paper_id is null)."""
    paper_id: Optional[str] = None
    spec: Optional[PaperBase] = None


# ---------------------------------------------------------------- elements
class Transform(Model):
    x: float = Field(0.0, description='mm, page space, element origin from page top-left')
    y: float = Field(0.0, description='mm, y down')
    scale: float = 1.0
    sx: float = 1.0
    sy: float = 1.0
    rotation: float = Field(0.0, description='degrees, clockwise on the page, around the element origin')


class FontMixEntry(Model):
    font_id: str
    weight: float = Field(1.0, ge=0)


class Jitter(Model):
    """FontsSet handwriting randomisation (field names as in layout.FontsSet)."""
    randomY: float = 0.0
    randomRotate: list[float] = [0.0, 0.0]
    randomFontSize: list[float] = [1.0, 1.0]
    randomSpace: list[float] = [1.0, 1.0]
    randomXScale: list[float] = [1.0, 1.0]
    randomYScale: list[float] = [1.0, 1.0]
    randomFirstPos: float = 0.0
    simple: float = Field(0.0, description='RDP tolerance in px (0 = off)')
    widthAdd: float = 0.0
    spaceWidthAdd: float = 0.0
    tabWidthAdd: float = 0.0
    baseLine: float = 1.0
    chars: str = '，,.。'


class Paragraph(Model):
    spe_type: Literal[0, 1, 2] = Field(0, description='0 none, 1 first-line indent, 2 hanging')
    spe_value: float = 0.0
    left: float = 0.0
    right: float = 0.0


Align = Literal['L', 'C', 'R', 'D']


class TextProps(OpenModel):
    text: str = ''
    font_id: Optional[str] = None
    font_mix: Optional[list[FontMixEntry]] = None
    size_mm: float = Field(8.0, gt=0, le=500, description='glyph em height in mm')
    line_height: float = Field(1.3, gt=0, le=10, description='line pitch = size_mm * line_height')
    char_space: float = Field(0.0, description='extra space between chars, mm')
    align: Align = 'L'
    box: Optional[dict[str, float]] = Field(None, description='{w, h} mm; text wraps at w, lines beyond h are dropped (warning)')
    jitter: Jitter = Jitter()
    seed: Optional[int] = None
    missing_glyph: Literal['box', 'skip'] = 'box'


class FlowTextProps(OpenModel):
    text: str = ''
    font_id: Optional[str] = None
    font_mix: Optional[list[FontMixEntry]] = None
    text_size: float = Field(1.0, gt=0, le=10, description='glyph scale relative to the ruled line height')
    char_space: float = Field(0.0, description='mm')
    align: Align = 'L'
    paragraph: Paragraph = Paragraph()
    line_num: Optional[int] = Field(None, ge=1, le=200, description='override paper ruling.line_num')
    jitter: Jitter = Jitter()
    seed: Optional[int] = None
    missing_glyph: Literal['box', 'skip'] = 'box'


class ImageProps(OpenModel):
    file_id: str
    mode: Literal['edge', 'skeleton', 'dots'] = 'edge'
    width_mm: float = Field(80.0, gt=0, le=2000)
    invert: bool = False
    th_low: float = 0.10
    th_high: float = 0.25
    blur: float = 1.4
    binarize: float = 0.5
    min_len: int = 6
    simplify: float = Field(0.6, description='RDP tolerance px')
    spacing_mm: float = 1.2
    gamma: float = 1.0
    max_px: int = 1200


class VectorProps(OpenModel):
    file_id: str
    units: Optional[Literal['auto', 'mm', 'cm', 'm', 'in', 'ft', 'pt', 'px']] = Field(
        'auto', description='auto: SVG width/height+viewBox (unit-less = 96 dpi px) / DXF $INSUNITS; '
                            'otherwise the size of one drawing unit')
    width_mm: Optional[float] = Field(None, description='scale to this width (keeps aspect); null = native size')
    flatten_tol_mm: float = 0.1
    layers: Optional[list[str]] = None
    stroke_filter: Optional[str] = None


class Hatch(Model):
    angle: float = 45.0
    spacing: float = 2.0


class ShapeProps(OpenModel):
    kind: Literal['rect', 'ellipse', 'line', 'polygon', 'grid'] = 'rect'
    w: float = 20.0
    h: float = 20.0
    points: Optional[list[list[float]]] = Field(None, description='polygon/line points [[x,y],...] mm, element-local')
    closed: bool = True
    rows: int = 1
    cols: int = 1
    grid_style: Literal['plain', 'tian', 'mi'] = Field('plain', description='plain grid, 田字格, 米字格')
    hatch: Optional[Hatch] = None


class GcodeProps(OpenModel):
    file_id: str
    as_paths: bool = True


class ElementBase(Model):
    id: str
    name: Optional[str] = None
    transform: Transform = Transform()
    z: int = 0
    locked: bool = False
    hidden: bool = False
    pen: int = 1


class TextElement(ElementBase):
    type: Literal['text'] = 'text'
    props: TextProps = TextProps()


class FlowTextElement(ElementBase):
    type: Literal['flow_text'] = 'flow_text'
    props: FlowTextProps = FlowTextProps()


class ImageElement(ElementBase):
    type: Literal['image'] = 'image'
    props: ImageProps


class SvgProps(VectorProps):
    text_mode: Literal['font', 'outline', 'skip'] = Field(
        'font', description='SVG <text>: font = draw with a single-stroke font; outline = only outlines the file '
                            'already has (live text is not drawn, warning); skip = ignore text')
    text_font_id: Optional[str] = Field(None, description='stroke font for SVG text; null = app default font')
    text_font_map: Optional[dict[str, str]] = Field(
        None, description='SVG font-family name (case-insensitive) -> font id; unmapped families use text_font_id')
    text_size_scale: float = Field(1.0, gt=0, le=10, description='multiplies every SVG font-size (baselines stay put)')
    text_jitter: Optional[Jitter] = Field(None, description='handwriting jitter (subset: randomFontSize, random[XY]Scale, '
                                                            'randomRotate, randomY, randomSpace, baseLine, simple)')
    text_seed: Optional[int] = Field(None, description='jitter seed; null = derived from the element id')
    missing_glyph: Literal['box', 'skip'] = 'box'


class SvgElement(ElementBase):
    type: Literal['svg'] = 'svg'
    props: SvgProps


class DxfElement(ElementBase):
    type: Literal['dxf'] = 'dxf'
    props: VectorProps


class ShapeElement(ElementBase):
    type: Literal['shape'] = 'shape'
    props: ShapeProps = ShapeProps()


class GcodeElement(ElementBase):
    type: Literal['gcode'] = 'gcode'
    props: GcodeProps


Element = Annotated[Union[TextElement, FlowTextElement, ImageElement, SvgElement,
                          DxfElement, ShapeElement, GcodeElement],
                    Field(discriminator='type')]


class BackgroundTransform(Model):
    """Placement of a reference background on the page (page mm, y down)."""
    x: float = Field(0.0, description='page mm of the image CENTRE')
    y: float = Field(0.0, description='page mm of the image centre, y down')
    scale: float = Field(0.1, gt=0, le=100, description='mm per image pixel (size = px_w*scale x px_h*scale)')
    rotation: float = Field(0.0, ge=-3600, le=3600, description='degrees, clockwise on the page, around the centre')


class BackgroundCalib(Model):
    """Last two-point calibration (image px), kept for re-editing and as snap targets."""
    a: list[float] = Field(min_length=2, max_length=2)
    b: list[float] = Field(min_length=2, max_length=2)
    mm: float = Field(gt=0, le=10000, description='real distance a-b')


class PageBackground(Model):
    """Reference background (scanned template / note sheet): shown in the studio and position
    preview only. NEVER rendered, drawn or exported to G-code/SVG/PDF; optional faint layer in PNG export."""
    file_id: str = Field(description='raster image (FileInfo kind image) as shown')
    source_id: Optional[str] = Field(None, description='original upload (PDF) the raster was made from')
    page: int = Field(0, ge=0, description='0-based PDF page of source_id')
    page_count: int = Field(1, ge=1)
    name: Optional[str] = None
    px_w: int = Field(gt=0)
    px_h: int = Field(gt=0)
    natural_mm: Optional[list[float]] = Field(None, description='[w, h] physical size if known (PDF page size / image DPI)')
    transform: BackgroundTransform = BackgroundTransform()
    opacity: float = Field(0.5, ge=0, le=1)
    visible: bool = True
    locked: bool = False
    calib: Optional[BackgroundCalib] = None


class Page(Model):
    id: str
    paper: Optional[PaperRef] = Field(None, description='override of doc.paper')
    origin: Optional[OriginSpec] = Field(None, description='override of the print origin')
    background: Optional[PageBackground] = Field(None, description='reference background (never printed)')
    elements: list[Element] = []


class Variable(Model):
    name: str = Field(pattern=r'^[A-Za-z_一-鿿][A-Za-z0-9_一-鿿]*$')
    default: str = ''
    type: Literal['text', 'number', 'date'] = 'text'
    label: Optional[str] = None


class ProjectDoc(Model):
    version: int = 1
    name: str = ''
    variables: list[Variable] = []
    paper: PaperRef = PaperRef(paper_id='a4-normal')
    print: PrintOverrides = PrintOverrides()
    pages: list[Page] = [Page(id='p1')]


class ProjectSeedInfo(Model):
    builtin: bool = Field(False, description='seeded template (id tpl-*): read-only, duplicate to edit')
    category: Optional[str] = None
    description: Optional[str] = None
    tags: list[str] = []
    variables_hint: list[str] = []
    sample_data: Optional[str] = Field(None, description='seed sample CSV name (imported into the library, tag 示例)')
    thumb_url: Optional[str] = None


class ProjectSummary(ProjectSeedInfo):
    id: str
    name: str
    is_template: bool
    pages: int
    rev: int
    updated_at: float
    created_at: float


class Project(ProjectSeedInfo):
    id: str
    name: str
    is_template: bool = False
    rev: int
    doc: ProjectDoc
    created_at: float
    updated_at: float


class ProjectCreate(Model):
    name: str = Field(min_length=1, max_length=120)
    doc: Optional[ProjectDoc] = None
    from_template_id: Optional[str] = None
    is_template: bool = False


class ProjectUpdate(Model):
    doc: ProjectDoc
    rev: int
    name: Optional[str] = None


class ElementPatch(Model):
    rev: Optional[int] = Field(None, description='if given, 409 rev_conflict when stale')
    page_id: Optional[str] = None
    transform: Optional[Transform] = None
    props: Optional[dict[str, Any]] = Field(None, description='shallow-merged into props')
    z: Optional[int] = None
    locked: Optional[bool] = None
    hidden: Optional[bool] = None
    name: Optional[str] = None


class SaveAsTemplate(Model):
    name: Optional[str] = None


class ProjectImportResult(Model):
    project: Project
    missing_fonts: list[str] = []
    imported_files: int = 0


# ---------------------------------------------------------------- batch
class BatchRequest(Model):
    data_file_id: str
    sheet: Optional[str] = None
    mapping: dict[str, str] = Field(description='{variable: column}')
    rows: Union[Literal['all'], list[int]] = 'all'
    name_pattern: str = '{{_row}}'
    overrides: Optional[PrintOverrides] = None
    preview_row: Optional[int] = Field(None, description='render only this row (preview), do not create jobs')


class BatchResult(Model):
    batch_id: Optional[str] = None
    jobs: list[str] = []
    rows: int = 0
    render: Optional['RenderResult'] = None
    missing_glyphs: Optional[dict[str, list[str]]] = Field(None, description='{"7": ["龘"]}: data rows (1-based) whose text has glyphs no font covers')


# ---------------------------------------------------------------- render
class RenderRequest(Model):
    pages: Union[Literal['all'], list[int]] = 'all'
    variables: dict[str, str] = {}
    row: Optional[int] = None
    overrides: Optional[PrintOverrides] = None
    profile_id: Optional[str] = None
    doc: Optional[ProjectDoc] = Field(None, description='render this unsaved doc instead of the stored one')


class RenderTextRequest(Model):
    text: str = Field(max_length=200000)
    font_id: Optional[str] = None
    font_mix: Optional[list[FontMixEntry]] = None
    paper: PaperRef = PaperRef(paper_id='a4-normal')
    align: Align = 'L'
    text_size: float = 1.0
    char_space: float = 0.0
    paragraph: Paragraph = Paragraph()
    jitter: Jitter = Jitter()
    seed: Optional[int] = None
    optimize: bool = False
    profile_id: Optional[str] = None
    overrides: Optional[PrintOverrides] = None


class PageStats(Model):
    draw_mm: float
    travel_mm: float
    pen_lifts: int
    strokes: int = 0


class PageWarnings(Model):
    missing_glyphs: list[str] = []
    clipped: bool = Field(False, description='content outside the paper')
    overflow: bool = Field(False, description='text did not fit its box')
    messages: list[str] = []


class RenderPage(Model):
    index: int
    source_page: int = Field(description='index of the project page that produced it')
    width_mm: float
    height_mm: float
    stats: PageStats
    bbox: Optional[list[float]] = Field(None, description='page space [minx,miny,maxx,maxy] mm, y down')
    machine_bbox: Optional[list[float]] = Field(None, description='machine coords [minx,miny,maxx,maxy] mm')
    est_s: float
    gcode_lines: int
    out_of_work_area: bool
    warnings: PageWarnings = PageWarnings()


class RenderResult(Model):
    rid: str
    created_at: float
    project_id: Optional[str] = None
    project_rev: Optional[int] = None
    profile_id: Optional[str] = None
    pages: list[RenderPage]
    elapsed_ms: float = 0.0


class RenderSave(Model):
    page: Optional[int] = Field(None, description='null = all pages')
    name: str = Field(min_length=1, max_length=120)


class RenderExport(Model):
    format: Literal['svg', 'png', 'pdf', 'gcode', 'zip']
    pages: Union[Literal['all'], list[int]] = 'all'
    dpi: int = Field(150, ge=36, le=600)
    space: Literal['page', 'machine'] = 'page'
    background: bool = Field(False, description='png only: draw the page reference background as a faint layer '
                                                'under the paths (never in gcode/svg/pdf)')


BatchResult.model_rebuild()


class PlacementInfo(Model):
    space: Literal['machine'] = 'machine'
    origin: list[float]
    origin_spec: dict[str, Any]
    work_area: list[float] = Field(description='[minx,miny,maxx,maxy] machine mm reachable from the origin')
    paper: list[list[float]] = Field(description='paper outline polygon, machine mm')
    bbox: Optional[list[float]] = Field(None, description='drawing bbox (with the previewed offset), machine mm')
    frame: list[list[float]] = Field(description='走边框 path (bbox corners), machine mm')
    offset_mm: list[float]
    machine_offset_mm: list[float]
    out_of_work_area: bool
    violations: list[str] = []
    fits_paper: bool
    est_s: float
    apply_hint: dict[str, Any]
