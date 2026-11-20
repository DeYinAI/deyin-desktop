using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Deyin.ComputerUseHost;

/// <summary>One serializer setup for every response: camelCase names, nulls omitted.</summary>
internal static class Json
{
  public static readonly JsonSerializerOptions Options = new()
  {
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
  };

  public static JsonNode ToNode<T>(T value) =>
    JsonSerializer.SerializeToNode(value, Options) ?? throw new InvalidOperationException("Could not serialize response.");
}
