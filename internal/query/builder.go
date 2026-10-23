package query

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// ErrInvalidQuery 表示查询意图不合法，handler 会映射为 400。
var ErrInvalidQuery = errors.New("invalid query")

// Spec 组装 SQL 所需的全部输入。不含任何 IO，方便表驱动测试。
type Spec struct {
	DatasourceKey string
	MidSQL        string
	DimMap        map[string]string
	MtxMap        map[string]string
	Dims          []string
	Metrics       []string
	Filters       []Filter
	OrderBy       []OrderBy
	Limit         int
	MaxLimit      int
	DefaultLimit  int
}

// Param 是 SQL 的命名参数，由引擎层转成驱动的参数绑定。
type Param struct {
	Name  string
	Value any
}

const midAlias = "__mid"

// Build 把查询意图组装成 ClickHouse SQL。
//
// 约定：mid_sql 的输出是「可以被再次聚合的中间结果」，外层按用户选的维度重新聚合，
// 这样指标口径统一、不会重复计算。
//
// 安全：dims / metrics / order_by / filter.field 全部走白名单枚举校验，
// 唯一的用户自由输入（过滤值）通过命名参数绑定，不参与字符串拼接。
func Build(spec Spec) (string, []Param, error) {
	midSQL := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(spec.MidSQL), ";"))
	if midSQL == "" {
		return "", nil, fmt.Errorf("%w: datasource 的 mid_sql 为空", ErrInvalidQuery)
	}
	if len(spec.Dims) == 0 && len(spec.Metrics) == 0 {
		return "", nil, fmt.Errorf("%w: 至少需要选择一个维度或一个指标", ErrInvalidQuery)
	}

	var selectParts []string
	var groupParts []string

	for _, dim := range spec.Dims {
		expr, ok := spec.DimMap[dim]
		if !ok {
			return "", nil, fmt.Errorf("%w: 维度 %q 不在该数据源的 dim_map 中", ErrInvalidQuery, dim)
		}
		selectParts = append(selectParts, fmt.Sprintf("%s AS %s", expr, quote(dim)))
		groupParts = append(groupParts, expr)
	}
	for _, mtx := range spec.Metrics {
		expr, ok := spec.MtxMap[mtx]
		if !ok {
			return "", nil, fmt.Errorf("%w: 指标 %q 不在该数据源的 mtx_map 中", ErrInvalidQuery, mtx)
		}
		selectParts = append(selectParts, fmt.Sprintf("%s AS %s", expr, quote(mtx)))
	}

	// 过滤只允许作用在维度上。指标过滤属于 HAVING 语义，一期不支持。
	var whereParts []string
	var params []Param
	for i, f := range spec.Filters {
		expr, ok := spec.DimMap[f.Field]
		if !ok {
			return "", nil, fmt.Errorf("%w: 过滤字段 %q 不在该数据源的 dim_map 中", ErrInvalidQuery, f.Field)
		}
		op := strings.ToLower(strings.TrimSpace(f.Op))
		if !allowedOps[op] {
			return "", nil, fmt.Errorf("%w: 不支持的操作符 %q", ErrInvalidQuery, f.Op)
		}
		name := fmt.Sprintf("p%d", i)
		if op == OpIn || op == OpNotIn {
			if len(f.Values) == 0 {
				return "", nil, fmt.Errorf("%w: %s 操作需要提供 values", ErrInvalidQuery, op)
			}
			whereParts = append(whereParts, fmt.Sprintf("%s %s ({%s:Array(String)})", expr, op, name))
			params = append(params, Param{Name: name, Value: f.Values})
			continue
		}
		if strings.TrimSpace(f.Value) == "" {
			return "", nil, fmt.Errorf("%w: 过滤字段 %q 的值为空", ErrInvalidQuery, f.Field)
		}
		whereParts = append(whereParts, fmt.Sprintf("%s %s {%s:String}", expr, op, name))
		params = append(params, Param{Name: name, Value: f.Value})
	}

	// 排序字段必须是已选中的维度或指标，否则无法在 SELECT 里找到对应列。
	var orderParts []string
	for _, o := range spec.OrderBy {
		isDim := contains(spec.Dims, o.Field)
		isMtx := contains(spec.Metrics, o.Field)
		if !isDim && !isMtx {
			return "", nil, fmt.Errorf("%w: 排序字段 %q 必须是已选择的维度或指标", ErrInvalidQuery, o.Field)
		}
		dir := "ASC"
		if o.Desc {
			dir = "DESC"
		}
		orderParts = append(orderParts, fmt.Sprintf("%s %s", quote(o.Field), dir))
	}

	limit := spec.Limit
	if limit <= 0 {
		limit = spec.DefaultLimit
	}
	if spec.MaxLimit > 0 && limit > spec.MaxLimit {
		limit = spec.MaxLimit
	}
	if limit <= 0 {
		limit = 1000
	}

	var sb strings.Builder
	sb.WriteString("SELECT\n  ")
	sb.WriteString(strings.Join(selectParts, ",\n  "))
	sb.WriteString("\nFROM (\n")
	sb.WriteString(midSQL)
	sb.WriteString("\n) AS ")
	sb.WriteString(midAlias)
	if len(whereParts) > 0 {
		sb.WriteString("\nWHERE ")
		sb.WriteString(strings.Join(whereParts, " AND "))
	}
	if len(groupParts) > 0 {
		sb.WriteString("\nGROUP BY ")
		sb.WriteString(strings.Join(groupParts, ", "))
	}
	if len(orderParts) > 0 {
		sb.WriteString("\nORDER BY ")
		sb.WriteString(strings.Join(orderParts, ", "))
	}
	sb.WriteString(fmt.Sprintf("\nLIMIT %d", limit))
	return sb.String(), params, nil
}

// BuildDimValuesSQL 生成「某维度的候选值」查询，供前端下拉枚举使用。
func BuildDimValuesSQL(midSQL string, dimExpr string, limit int) string {
	mid := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(midSQL), ";"))
	return fmt.Sprintf(
		"SELECT DISTINCT %s AS value FROM (\n%s\n) AS %s WHERE %s IS NOT NULL ORDER BY value LIMIT %d",
		dimExpr, mid, midAlias, dimExpr, limit,
	)
}

// quote 用反引号包裹标识符。内部已做反引号转义，避免列名本身含反引号时破坏语法。
func quote(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// SortedKeys 返回 map 的排序后的 key 列表，保证前端看到的维度/指标顺序稳定。
func SortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
