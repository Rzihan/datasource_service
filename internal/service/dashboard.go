package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"dataset_service/internal/model"
	"dataset_service/internal/repo"
)

// ErrDashboardInvalid 参数不合法。单独一个哨兵而不是直接返回裸 error：
// handler 要能把它翻译成 400，而不是当成内部错误报 500——
// 「key 里写了大写字母」是用户改一下就行的事，不是服务坏了。
var ErrDashboardInvalid = errors.New("invalid dashboard")

// 大盘的容量上限。不是技术限制：一屏放三十个面板，
// 它就不再是「看板」而是一张没排好版的表，没人会往下翻。
const (
	MaxPanels  = 24
	MaxFilters = 8
	MinSpan    = 1
	MaxSpan    = 12
	MinHeight  = 140
	MaxHeight  = 800
)

// dashboardKeyPattern 与入口 key 同款约束：key 要进 URL，
// 大小写混写 / 带空格的链接在复制传播时经常变形，
// 而菜单链接恰恰是最常被复制的东西。
var dashboardKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// DashboardService 承载大盘的业务规则。
type DashboardService struct {
	repo *repo.DashboardRepo
}

// NewDashboardService 构造服务。
func NewDashboardService(r *repo.DashboardRepo) *DashboardService {
	return &DashboardService{repo: r}
}

// List 列出全部大盘。
func (s *DashboardService) List(ctx context.Context) ([]*model.Dashboard, error) {
	items, err := s.repo.ListAll(ctx, 0)
	if err != nil {
		return nil, err
	}
	for _, it := range items {
		normalizePanelsInPlace(it)
	}
	return items, nil
}

// Get 查询单条大盘。
func (s *DashboardService) Get(ctx context.Context, key string) (*model.Dashboard, error) {
	key, err := normalizeDashboardKey(key)
	if err != nil {
		return nil, err
	}
	m, err := s.repo.GetByKey(ctx, key)
	if err != nil {
		return nil, err
	}
	normalizePanelsInPlace(m)
	return m, nil
}

// Create 新建大盘。
func (s *DashboardService) Create(ctx context.Context, req *model.DashboardCreateRequest, operator string) (*model.Dashboard, error) {
	key, err := normalizeDashboardKey(req.Key)
	if err != nil {
		return nil, err
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		// 不给标题兜底成 key：大盘是要挂在菜单上的，
		// 菜单上出现一个 key 谁也看不懂那是什么。
		return nil, fmt.Errorf("%w: 标题不能为空", ErrDashboardInvalid)
	}
	now := time.Now()
	m := &model.Dashboard{
		Key:       key,
		Title:     title,
		Module:    strings.TrimSpace(req.Module),
		Desc:      strings.TrimSpace(req.Desc),
		Owner:     strings.TrimSpace(req.Owner),
		Legacy:    strings.TrimSpace(req.Legacy),
		Panels:    normalizePanels(req.Panels),
		Filters:   normalizeFilters(req.Filters),
		Version:   0,
		CreatedBy: operator,
		UpdatedBy: operator,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.repo.Create(ctx, m); err != nil {
		return nil, err
	}
	return m, nil
}

// Update 更新大盘（乐观锁）。只更新传了的字段，不传的不动。
func (s *DashboardService) Update(ctx context.Context, key string, req *model.DashboardUpdateRequest, operator string) (*model.Dashboard, error) {
	key, err := normalizeDashboardKey(key)
	if err != nil {
		return nil, err
	}
	patch := map[string]interface{}{}
	if req.Title != nil {
		if t := strings.TrimSpace(*req.Title); t != "" {
			patch["title"] = t
		}
	}
	if req.Module != nil {
		patch["module"] = strings.TrimSpace(*req.Module)
	}
	if req.Desc != nil {
		// 列名是 descr（desc 是 MySQL 关键字，用作列名会到处要加反引号）。
		// 这里必须写列名：gorm 按 map 的 key 找字段时认的是列名，
		// 写 "desc" 会生成一段 Unknown column 的 UPDATE。
		patch["descr"] = strings.TrimSpace(*req.Desc)
	}
	if req.Owner != nil {
		patch["owner"] = strings.TrimSpace(*req.Owner)
	}
	if req.Legacy != nil {
		patch["legacy"] = strings.TrimSpace(*req.Legacy)
	}
	// 切片没有「没传」和「传了空」的区别：空数组既可能是「清空所有面板」，
	// 也可能是前端压根没带这个字段。这里按「带了就照做」处理，
	// 因为清空面板是一个合法动作，而误清空的代价（重新加回来）远小于
	// 想清空却清不掉（只能删掉整张大盘重建）。
	if req.Panels != nil {
		// 必须自己序列化：gorm 的 serializer:json 在 Updates(map) 这条路上
		// 不生效，直接塞结构体进去会生成 `panels=('{...}','{...}')`，
		// MySQL 报 1241 Operand should contain 1 column(s)。
		patch["panels"] = mustJSON(normalizePanels(req.Panels))
	}
	if req.Filters != nil {
		patch["filters"] = mustJSON(normalizeFilters(req.Filters))
	}
	if len(patch) == 0 {
		return s.Get(ctx, key)
	}
	patch["version"] = req.Version + 1
	patch["updated_by"] = operator
	patch["updated_at"] = time.Now()

	if err := s.repo.Update(ctx, key, req.Version, patch); err != nil {
		return nil, err
	}
	return s.Get(ctx, key)
}

// Delete 软删大盘。
func (s *DashboardService) Delete(ctx context.Context, key string) error {
	key, err := normalizeDashboardKey(key)
	if err != nil {
		return err
	}
	return s.repo.Delete(ctx, key, time.Now().UnixMilli())
}

// mustJSON 序列化面板 / 筛选器。序列化失败不该让整次保存失败，
// 退化成空数组的代价远小于「改不动这张大盘」。
func mustJSON(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "[]"
	}
	return string(b)
}

func normalizeDashboardKey(key string) (string, error) {
	k := strings.TrimSpace(key)
	if !dashboardKeyPattern.MatchString(k) {
		return "", fmt.Errorf("%w: key 只能由小写字母、数字、短横线组成，且不能以短横线开头", ErrDashboardInvalid)
	}
	return k, nil
}

// normalizePanels 面板清洗。三条硬规则：
//
//  1. 没有数据集的面板直接丢掉——它永远跑不出数，在大盘上就是一个
//     永远转圈的方块，比没有更糟（用户会以为系统卡了）。
//  2. 视图不认识就退回表格：表格不需要维度也能出数，是唯一一个
//     任何查询都能画出来的形态，所以它是安全的兜底。
//  3. 尺寸钳到合法区间：越界的 span 会把整行撑爆，
//     height 过小则图表连坐标轴都画不出来。
func normalizePanels(in []model.DashboardPanel) []model.DashboardPanel {
	out := make([]model.DashboardPanel, 0, len(in))
	used := map[string]bool{}
	for i, p := range in {
		ds := strings.TrimSpace(p.Dataset)
		if ds == "" {
			continue
		}
		id := strings.TrimSpace(p.ID)
		if id == "" || used[id] {
			// 作者不填或填重了就自己编一个：面板的身份必须稳定且唯一，
			// 否则「编辑中的面板」在大盘刷新后会跳到另一个面板上。
			id = fmt.Sprintf("p%d", i+1)
			for used[id] {
				id += "x"
			}
		}
		used[id] = true
		view := strings.TrimSpace(p.View)
		switch view {
		case model.PanelViewMetric, model.PanelViewLine, model.PanelViewColumn, model.PanelViewPie:
		default:
			view = model.PanelViewTable
		}
		span := p.Span
		if span < MinSpan || span > MaxSpan {
			span = MaxSpan / 2
		}
		height := p.Height
		if height < MinHeight || height > MaxHeight {
			height = 260
		}
		out = append(out, model.DashboardPanel{
			ID:      id,
			Title:   strings.TrimSpace(p.Title),
			Note:    strings.TrimSpace(p.Note),
			Dataset: ds,
			Query:   strings.TrimSpace(p.Query),
			View:    view,
			Span:       span,
			Height:     height,
			Metric:     strings.TrimSpace(p.Metric),
			Follow:     p.Follow,
			EmitFilter: strings.TrimSpace(p.EmitFilter),
		})
		if len(out) >= MaxPanels {
			break
		}
	}
	return out
}

// normalizeFilters 筛选器清洗：没有字段名的一律丢掉。
// 一个不生效的筛选器在大盘顶部占一行，却什么也筛不掉，
// 用户会以为是数据有问题。
func normalizeFilters(in []model.DashboardPanelFilter) []model.DashboardPanelFilter {
	out := make([]model.DashboardPanelFilter, 0, len(in))
	for _, f := range in {
		field := strings.TrimSpace(f.Field)
		if field == "" {
			continue
		}
		out = append(out, model.DashboardPanelFilter{
			Field:   field,
			Label:   strings.TrimSpace(f.Label),
			Dataset: strings.TrimSpace(f.Dataset),
			Default: strings.TrimSpace(f.Default),
		})
		if len(out) >= MaxFilters {
			break
		}
	}
	return out
}

// normalizePanelsInPlace 读路径上补一遍默认值。
// 老数据可能是在某条规则上线之前写进去的，读的时候兜住，
// 免得前端拿到 height=0 画出一个空白面板。
func normalizePanelsInPlace(m *model.Dashboard) {
	if m == nil {
		return
	}
	m.Panels = normalizePanels(m.Panels)
	m.Filters = normalizeFilters(m.Filters)
}
