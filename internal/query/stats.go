package query

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"dataset_service/internal/model"
)

// DatasetStats 数据集的体检报告。
//
// 数据集交出去之后，使用者真正卡住的不是「怎么查」，而是「敢不敢用」：
// 这个数有多少行？覆盖到哪天？上周的数据到齐了吗？口径是谁定的、找谁问？
// 这些都不在 dim_map / mtx_map 里，也不在 SQL 里，只能扫一遍数据 + 读说明书才能答。
type DatasetStats struct {
	DatasetKey string `json:"dataset_key"`
	// 数据侧：扫出来的
	RowCount   int64  `json:"row_count"`
	DateField  string `json:"date_field,omitempty"`
	MinDate    string `json:"min_date,omitempty"`
	MaxDate    string `json:"max_date,omitempty"`
	CoverDays  int    `json:"cover_days"` // 覆盖天数（含首尾）
	LagDays    int    `json:"lag_days"`   // max_date 距今多少天，负值表示数据里出现了未来日期
	ElapsedMs  int64  `json:"elapsed_ms"`
	ScannedAt  string `json:"scanned_at"`
	Cached     bool   `json:"cached"`
	// 扫描失败不连坐：卡片要能显示「扫不出来」，而不是整个查询页打不开
	Error string `json:"error,omitempty"`

	// 配置侧：从数据集读出来的
	DimCount      int    `json:"dim_count"`
	MultiDimCount int    `json:"multi_dim_count"`
	MetricCount   int    `json:"metric_count"`
	Owner         string `json:"owner,omitempty"`
	UpdateFreq    string `json:"update_freq,omitempty"`
	UpdatedAt     string `json:"updated_at,omitempty"`
	UpdatedBy     string `json:"updated_by,omitempty"`
	ConfigVersion int    `json:"config_version"`
}

// statsTTL 统计结果的有效期。
// 行数天天变，但「这个数据集大概有多少行、覆盖到哪天」不需要实时——
// 真正会变的是「今天的数据到没到齐」，十分钟足够。
const statsTTL = 10 * time.Minute

type statsEntry struct {
	stats   *DatasetStats
	expires time.Time
}

// statsCache 进程内缓存。计数查询要扫全表，每次开查询页都跑一遍纯属浪费。
// 放进程内的代价是多个副本之间不一致——这是展示用的体检报告，不是账，能接受。
type statsCache struct {
	mu      sync.Mutex
	items   map[string]statsEntry
	locks   map[string]*sync.Mutex
	ttl     time.Duration
	maxKeys int
}

func newStatsCache(ttl time.Duration) *statsCache {
	return &statsCache{items: map[string]statsEntry{}, locks: map[string]*sync.Mutex{}, ttl: ttl, maxKeys: 512}
}

func (c *statsCache) get(key string) (*DatasetStats, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok || time.Now().After(e.expires) {
		return nil, false
	}
	// 交出副本：调用方会改 Cached 之类的标记，改到缓存里的对象上，
	// 下一次命中就会拿到被改脏的版本。
	clone := *e.stats
	return &clone, true
}

func (c *statsCache) set(key string, s *DatasetStats) {
	c.setTTL(key, s, c.ttl)
}

func (c *statsCache) setTTL(key string, s *DatasetStats, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// 缓存 key 里带登录态，切租户会攒出不少 key；超阈值整表清掉，
	// 不做 LRU——这种规模下 LRU 的复杂度换不来什么。
	if len(c.items) >= c.maxKeys {
		c.items = map[string]statsEntry{}
	}
	c.items[key] = statsEntry{stats: s, expires: time.Now().Add(ttl)}
}

// lockFor 取这个 key 的串行锁：同一个数据集被并发打开时只扫一次，
// 避免三个人同时开页面就把全表扫三遍。
func (c *statsCache) lockFor(key string) *sync.Mutex {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, ok := c.locks[key]
	if !ok {
		m = &sync.Mutex{}
		c.locks[key] = m
	}
	return m
}

// Stats 扫描一个数据集的规模与新鲜度。缓存 10 分钟，扫描失败不返回 error，
// 而是把原因放进 Error 字段——卡片上写「扫不出来」比页面级报错有用。
func (s *Service) Stats(ctx context.Context, datasetKey string, tenants, users []string) (*DatasetStats, error) {
	ds, err := s.repo.GetByKey(ctx, datasetKey)
	if err != nil {
		return nil, err
	}
	if !ds.ACL.Allows(tenants) {
		return nil, fmt.Errorf("%w: 当前登录态的租户无权访问数据集 %q", ErrForbidden, datasetKey)
	}

	// 配置侧的信息不查数仓，先填好：扫描失败时至少还有这些能用
	out := &DatasetStats{
		DatasetKey:    ds.DatasetKey,
		DimCount:      len(ds.DimMap),
		MultiDimCount: len(ds.MultiDimMap),
		MetricCount:   len(ds.MtxMap),
		Owner:         ds.Meta.Owner,
		UpdateFreq:    ds.Meta.UpdateFreq,
		ConfigVersion: ds.Version,
		UpdatedBy:     ds.UpdatedBy,
	}
	if !ds.UpdatedAt.IsZero() {
		out.UpdatedAt = ds.UpdatedAt.Format("2006-01-02 15:04")
	}

	// 缓存 key 带登录态：行级过滤会让不同人看到的行数不同，
	// 用同一个 key 会把别人的行数显示给你。
	ck := datasetKey + "|" + strings.Join(tenants, ",") + "|" + strings.Join(users, ",")
	if cached, ok := s.stats.get(ck); ok {
		clone := *cached
		clone.Cached = true
		return &clone, nil
	}

	lock := s.stats.lockFor(ck)
	lock.Lock()
	defer lock.Unlock()
	if cached, ok := s.stats.get(ck); ok {
		clone := *cached
		clone.Cached = true
		return &clone, nil
	}

	if err := s.fillScan(ctx, ds, out, tenants, users); err != nil {
		slog.Warn("dataset stats scan failed", "dataset_key", ds.DatasetKey, "err", err)
		out.Error = err.Error()
	}
	out.ScannedAt = time.Now().Format("2006-01-02 15:04:05")
	// 扫失败也缓存，但只缓存 30 秒：一次抖动不该在十分钟内一直显示「扫不出来」
	if out.Error != "" {
		s.stats.setTTL(ck, out, 30*time.Second)
	} else {
		s.stats.set(ck, out)
	}
	clone := *out
	return &clone, nil
}

// fillScan 跑一次 count + 日期覆盖扫描。
func (s *Service) fillScan(ctx context.Context, ds *model.DatasetConfig, out *DatasetStats, tenants, users []string) error {
	rfSpec := RowFilterSpec{
		TenantColumn: ds.ACL.RowFilter.Tenant.Column,
		UserColumn:   ds.ACL.RowFilter.User.Column,
	}
	// 模板渲染：把全部维度与指标都传进去，保证 JOIN 不被裁掉，
	// 否则数出来的行数是「裁剪后」的行数，比真实的小。
	allFields := make([]string, 0, len(ds.DimMap)+len(ds.MultiDimMap)+len(ds.MtxMap))
	for k := range ds.DimMap {
		allFields = append(allFields, k)
	}
	for k := range ds.MultiDimMap {
		allFields = append(allFields, k)
	}
	for k := range ds.MtxMap {
		allFields = append(allFields, k)
	}
	sort.Strings(allFields)
	midSQL, err := RenderMidSQL(ds.MidSQL, MidSQLData{
		Fields:  allFields,
		Filters: rowFilterColumns(rfSpec),
	})
	if err != nil {
		return err
	}

	// 注意要用 dim_map 里的**列表达式**而不是维名：
	// 子查询里叫 stat_date，维名叫 date，直接写 date 会报 Unknown identifier。
	dateField := pickDateField(ds.DimMap)
	dateExpr := ""
	if dateField != "" {
		dateExpr = ds.DimMap[dateField]
	}
	var params []Param
	var where []string
	for i, rf := range buildRowFilters(ds, tenants, users) {
		if rf.Expr == "" {
			continue
		}
		name := fmt.Sprintf("rf%d", i)
		values := rf.Values
		if values == nil {
			values = []string{}
		}
		where = append(where, fmt.Sprintf("%s IN ({%s:Array(String)})", rf.Expr, name))
		params = append(params, Param{Name: name, Value: values})
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " WHERE " + strings.Join(where, " AND ")
	}

	var sqlText string
	if dateExpr != "" {
		sqlText = fmt.Sprintf(
			"SELECT count() AS v_c, min(%s) AS v_min, max(%s) AS v_max FROM (\n%s\n) AS %s%s",
			quote(dateExpr), quote(dateExpr), midSQL, midAlias, whereSQL,
		)
		out.DateField = dateField
	} else {
		sqlText = fmt.Sprintf("SELECT count() AS v_c FROM (\n%s\n) AS %s%s", midSQL, midAlias, whereSQL)
	}

	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return ctx.Err()
	}
	queryCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	start := time.Now()
	res, err := s.engine.Query(queryCtx, sqlText, params)
	out.ElapsedMs = time.Since(start).Milliseconds()
	if err != nil {
		return err
	}
	if len(res.Rows) == 0 || len(res.Rows[0]) == 0 {
		return fmt.Errorf("扫描没有返回结果")
	}
	out.RowCount = toInt64(res.Rows[0][0])
	if dateField != "" && len(res.Rows[0]) >= 3 {
		minS := dateString(res.Rows[0][1])
		maxS := dateString(res.Rows[0][2])
		out.MinDate = minS
		out.MaxDate = maxS
		out.CoverDays = daysBetween(minS, maxS)
		out.LagDays = daysBetween(maxS, time.Now().Format("2006-01-02"))
	}
	return nil
}

// pickDateField 从维度里挑一个日期列：名字含 date / dt / day / 时间 的优先，
// 然后按字典序取第一个，保证同一数据集每次挑到同一列（否则缓存里的口径会跳）。
func pickDateField(dims map[string]string) string {
	keys := make([]string, 0, len(dims))
	for k := range dims {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		lk := strings.ToLower(k)
		if strings.Contains(lk, "date") || strings.Contains(lk, "day") || strings.Contains(lk, "dt") || strings.Contains(lk, "time") {
			return k
		}
	}
	return ""
}

func toInt64(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int32:
		return int64(t)
	case uint64:
		return int64(t)
	case uint32:
		return int64(t)
	case int:
		return int64(t)
	case float64:
		return int64(t)
	case nil:
		return 0
	default:
		var n int64
		if _, err := fmt.Sscanf(fmt.Sprintf("%v", v), "%d", &n); err != nil {
			return 0
		}
		return n
	}
}

// dateString 把 ClickHouse 返回的日期统一成 YYYY-MM-DD。
// Date 类型回来是 time.Time，String 类型回来是字符串，Nullable 又多一层指针。
func dateString(v any) string {
	switch t := v.(type) {
	case time.Time:
		return t.Format("2006-01-02")
	case *time.Time:
		if t == nil {
			return ""
		}
		return t.Format("2006-01-02")
	case string:
		if len(t) >= 10 {
			return t[:10]
		}
		return t
	case nil:
		return ""
	default:
		s := fmt.Sprintf("%v", t)
		if len(s) >= 10 {
			return s[:10]
		}
		return s
	}
}

func daysBetween(a, b string) int {
	if len(a) < 10 || len(b) < 10 {
		return 0
	}
	ta, err1 := time.Parse("2006-01-02", a[:10])
	tb, err2 := time.Parse("2006-01-02", b[:10])
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(tb.Sub(ta).Hours()/24) + 1
}
